use anchor_lang::prelude::*;
use anchor_lang::Discriminator;
use anchor_lang::system_program::{self, Transfer as SystemTransfer};
use anchor_spl::token::{self, Burn, Mint, Token, TokenAccount};
use std::collections::BTreeMap;

// NOTE: Testnet program id placeholder. We'll generate a real program id when deploying to testnet.
declare_id!("HAWdiMtvTfiFhENgxPdWEgBQmoa3A5oN1KV9N3LSmxXz");

const CONFIG_SEED: &[u8] = b"melt_config";
const VAULT_SEED: &[u8] = b"melt_vault";
const ROUND_SEED: &[u8] = b"melt_round";
const USER_ROUND_SEED: &[u8] = b"melt_user_round";

#[program]
pub mod melt_v1 {
    use super::*;

    pub fn init_melt(ctx: Context<InitMelt>, params: InitMeltParams) -> Result<()> {
        require!(params.vault_cap_xnt > 0, MeltError::InvalidParams);
        require!(params.rollover_bps <= 10_000, MeltError::InvalidParams);
        require!(params.round_window_sec > 0, MeltError::InvalidParams);

        let cfg = &mut ctx.accounts.config;
        cfg.admin = ctx.accounts.admin.key();
        cfg.mind_mint = ctx.accounts.mind_mint.key();
        cfg.vault = ctx.accounts.vault.key();
        cfg.vault_cap_lamports = params.vault_cap_xnt;
        cfg.rollover_bps = params.rollover_bps;
        cfg.burn_min = params.burn_min;
        cfg.round_window_sec = params.round_window_sec;
        cfg.test_mode = params.test_mode;
        cfg.bump_config = *ctx.bumps.get("config").unwrap();
        cfg.bump_vault = *ctx.bumps.get("vault").unwrap();
        cfg.round_seq = 0;
        cfg.vial_lamports = 0;
        cfg.bonus_pool_lamports = 0;
        cfg.active_round_seq = 0;
        cfg.active_round_active = false;
        cfg.pending_window_sec = 0;
        Ok(())
    }

    /// Admin can change parameters (testnet tuning).
    pub fn admin_set_params(ctx: Context<AdminSetParams>, params: AdminSetParamsParams) -> Result<()> {
        let cfg = &mut ctx.accounts.config;
        require_keys_eq!(cfg.admin, ctx.accounts.admin.key(), MeltError::Unauthorized);

        if let Some(v) = params.vault_cap_xnt {
            require!(v > 0, MeltError::InvalidParams);
            cfg.vault_cap_lamports = v;
        }
        if let Some(bps) = params.rollover_bps {
            require!(bps <= 10_000, MeltError::InvalidParams);
            cfg.rollover_bps = bps;
        }
        if let Some(b) = params.burn_min {
            cfg.burn_min = b;
        }
        if let Some(w) = params.round_window_sec {
            require!(w > 0, MeltError::InvalidParams);
            cfg.round_window_sec = w;
        }
        Ok(())
    }

    /// Reallocates config to the latest size (testnet migration).
    pub fn admin_migrate_config(ctx: Context<AdminMigrateConfig>) -> Result<()> {
        migrate_melt_config_account(
            &ctx.accounts.admin.to_account_info(),
            &ctx.accounts.config.to_account_info(),
        )
    }

    /// Admin can set a custom schedule for the next round (testnet).
    pub fn admin_set_schedule(ctx: Context<AdminSetSchedule>, start_ts: i64, end_ts: i64) -> Result<()> {
        let cfg = &mut ctx.accounts.config;
        require_keys_eq!(cfg.admin, ctx.accounts.admin.key(), MeltError::Unauthorized);
        require!(end_ts > start_ts, MeltError::InvalidParams);

        let now = Clock::get()?.unix_timestamp;
        require!(end_ts > now, MeltError::InvalidParams);

        require!(cfg.test_mode, MeltError::InvalidParams);
        let duration = end_ts
            .checked_sub(start_ts)
            .ok_or(MeltError::MathOverflow)?;
        cfg.pending_window_sec = u64::try_from(duration).map_err(|_| MeltError::MathOverflow)?;
        Ok(())
    }

    /// Top up the vial (next round progress) with native XNT (lamports). For tests.
    pub fn admin_topup_vial(ctx: Context<AdminTopupVial>, lamports: u64) -> Result<()> {
        require!(lamports > 0, MeltError::InvalidParams);
        let cfg = &mut ctx.accounts.config;
        require_keys_eq!(cfg.admin, ctx.accounts.admin.key(), MeltError::Unauthorized);

        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                SystemTransfer {
                    from: ctx.accounts.admin.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                },
            ),
            lamports,
        )?;
        cfg.vial_lamports = cfg
            .vial_lamports
            .checked_add(lamports)
            .ok_or(MeltError::MathOverflow)?;

        emit!(FundingRecorded {
            amount: lamports,
            vial_lamports: cfg.vial_lamports,
        });
        if let Some(info) = try_start_round(cfg, &mut ctx.accounts.round, &ctx.bumps, false)? {
            emit!(RoundStarted {
                seq: info.seq,
                start_ts: info.start_ts,
                end_ts: info.end_ts,
                pot: info.pot,
                v_pay: info.v_pay,
            });
        }
        Ok(())
    }

    /// Backwards-compatible topup (same as admin_topup_vial).
    pub fn admin_topup_vault(ctx: Context<AdminTopupVault>, lamports: u64) -> Result<()> {
        require!(lamports > 0, MeltError::InvalidParams);
        let cfg = &mut ctx.accounts.config;
        require_keys_eq!(cfg.admin, ctx.accounts.admin.key(), MeltError::Unauthorized);

        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                SystemTransfer {
                    from: ctx.accounts.admin.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                },
            ),
            lamports,
        )?;
        cfg.vial_lamports = cfg
            .vial_lamports
            .checked_add(lamports)
            .ok_or(MeltError::MathOverflow)?;
        emit!(FundingRecorded {
            amount: lamports,
            vial_lamports: cfg.vial_lamports,
        });
        if let Some(info) = try_start_round(cfg, &mut ctx.accounts.round, &ctx.bumps, false)? {
            emit!(RoundStarted {
                seq: info.seq,
                start_ts: info.start_ts,
                end_ts: info.end_ts,
                pot: info.pot,
                v_pay: info.v_pay,
            });
        }
        Ok(())
    }

    /// Record funding already transferred into the MELT vault.
    /// Permissionless; intended for CPI from other programs.
    pub fn record_funding(ctx: Context<RecordFunding>, lamports: u64) -> Result<()> {
        require!(lamports > 0, MeltError::InvalidParams);
        let cfg = &mut ctx.accounts.config;

        cfg.vial_lamports = cfg
            .vial_lamports
            .checked_add(lamports)
            .ok_or(MeltError::MathOverflow)?;
        emit!(FundingRecorded {
            amount: lamports,
            vial_lamports: cfg.vial_lamports,
        });
        if let Some(info) = try_start_round(cfg, &mut ctx.accounts.round, &ctx.bumps, false)? {
            emit!(RoundStarted {
                seq: info.seq,
                start_ts: info.start_ts,
                end_ts: info.end_ts,
                pot: info.pot,
                v_pay: info.v_pay,
            });
        }
        Ok(())
    }

    /// Withdraw from vault back to admin. Only allowed in test_mode.
    pub fn admin_withdraw_vault(ctx: Context<AdminWithdrawVault>, lamports: u64) -> Result<()> {
        require!(lamports > 0, MeltError::InvalidParams);
        let cfg = &mut ctx.accounts.config;
        require_keys_eq!(cfg.admin, ctx.accounts.admin.key(), MeltError::Unauthorized);
        require!(cfg.test_mode, MeltError::WithdrawDisabled);

        require!(cfg.vial_lamports >= lamports, MeltError::InsufficientVaultBalance);
        cfg.vial_lamports = cfg
            .vial_lamports
            .checked_sub(lamports)
            .ok_or(MeltError::MathOverflow)?;

        // NOTE: vault is program-owned, so we move lamports directly.
        {
            let vault_ai = ctx.accounts.vault.to_account_info();
            let admin_ai = ctx.accounts.admin.to_account_info();
            let mut vault_lamports = vault_ai.try_borrow_mut_lamports()?;
            let mut admin_lamports = admin_ai.try_borrow_mut_lamports()?;
            let new_vault = (*vault_lamports)
                .checked_sub(lamports)
                .ok_or(MeltError::MathOverflow)?;
            let new_admin = (*admin_lamports)
                .checked_add(lamports)
                .ok_or(MeltError::MathOverflow)?;
            **vault_lamports = new_vault;
            **admin_lamports = new_admin;
        }
        Ok(())
    }

    /// Start a new round. Creates a round account with a snapshot of the payout pool.
    pub fn start_round(ctx: Context<StartRound>) -> Result<()> {
        let cfg = &mut ctx.accounts.config;
        require_keys_eq!(cfg.admin, ctx.accounts.admin.key(), MeltError::Unauthorized);
        require!(cfg.test_mode, MeltError::InvalidParams);
        if let Some(info) = try_start_round(cfg, &mut ctx.accounts.round, &ctx.bumps, true)? {
            emit!(RoundStarted {
                seq: info.seq,
                start_ts: info.start_ts,
                end_ts: info.end_ts,
                pot: info.pot,
                v_pay: info.v_pay,
            });
        }
        Ok(())
    }

    /// Burn MIND during an active round.
    pub fn burn_mind(ctx: Context<BurnMind>, amount: u64) -> Result<()> {
        require!(amount > 0, MeltError::InvalidParams);
        let now = Clock::get()?.unix_timestamp;
        let cfg = &ctx.accounts.config;
        let round = &mut ctx.accounts.round;
        require!(round.status == RoundStatus::Active, MeltError::BadRoundStatus);
        require!(now >= round.start_ts && now <= round.end_ts, MeltError::RoundNotActive);

        // Optional spam guard.
        if cfg.burn_min > 0 {
            require!(amount >= cfg.burn_min, MeltError::BelowBurnMin);
        }

        // Burn from user's ATA (user signs).
        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.mind_mint.to_account_info(),
                    from: ctx.accounts.user_mind_ata.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount,
        )?;

        let ur = &mut ctx.accounts.user_round;
        ur.user = ctx.accounts.user.key();
        ur.round = round.key();
        ur.burned = ur
            .burned
            .checked_add(amount)
            .ok_or(MeltError::MathOverflow)?;
        ur.claimed = false;
        ur.bump = *ctx.bumps.get("user_round").unwrap();

        round.total_burn = round
            .total_burn
            .checked_add(amount)
            .ok_or(MeltError::MathOverflow)?;

        emit!(Burned {
            user: ctx.accounts.user.key(),
            round: round.key(),
            amount,
            total_burn: round.total_burn,
        });
        Ok(())
    }

    /// Finalize a round after it ends. Computes v_pay = (1-rollover)*v_round.
    pub fn finalize_round(ctx: Context<FinalizeRound>) -> Result<()> {
        let cfg = &mut ctx.accounts.config;
        let now = Clock::get()?.unix_timestamp;
        let round = &mut ctx.accounts.round;
        let rollover = finalize_active_round_if_ended(cfg, round, now)?;
        emit!(Finalized { seq: round.seq, rollover });
        if let Some(info) = try_start_round(cfg, &mut ctx.accounts.next_round, &ctx.bumps, false)? {
            emit!(RoundStarted {
                seq: info.seq,
                start_ts: info.start_ts,
                end_ts: info.end_ts,
                pot: info.pot,
                v_pay: info.v_pay,
            });
        }
        Ok(())
    }

    /// Claim pro-rata XNT for a finalized round.
    /// If the active round already ended, this call auto-finalizes it first.
    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let cfg = &mut ctx.accounts.config;
        let round = &mut ctx.accounts.round;

        if round.status == RoundStatus::Active {
            let rollover = finalize_active_round_if_ended(cfg, round, now)?;
            emit!(Finalized { seq: round.seq, rollover });
        }
        if let Some(info) = try_start_round(cfg, &mut ctx.accounts.next_round, &ctx.bumps, false)? {
            emit!(RoundStarted {
                seq: info.seq,
                start_ts: info.start_ts,
                end_ts: info.end_ts,
                pot: info.pot,
                v_pay: info.v_pay,
            });
        }
        require!(round.status == RoundStatus::Finalized, MeltError::BadRoundStatus);

        let ur = &mut ctx.accounts.user_round;
        require!(!ur.claimed, MeltError::AlreadyClaimed);
        require!(ur.burned > 0, MeltError::NothingToClaim);

        // If nobody burned, payout is zero.
        if round.total_burn == 0 || round.v_pay == 0 {
            ur.claimed = true;
            return Ok(());
        }

        // payout = v_pay * burned / total_burn
        let num = (round.v_pay as u128)
            .checked_mul(ur.burned as u128)
            .ok_or(MeltError::MathOverflow)?;
        let payout = num
            .checked_div(round.total_burn as u128)
            .ok_or(MeltError::MathOverflow)?;
        let payout_u64 = u64::try_from(payout).map_err(|_| MeltError::MathOverflow)?;

        let vault_balance = ctx.accounts.vault.to_account_info().lamports();
        require!(vault_balance >= payout_u64, MeltError::InsufficientVaultBalance);

        // NOTE: vault is program-owned, so we move lamports directly.
        {
            let vault_ai = ctx.accounts.vault.to_account_info();
            let user_ai = ctx.accounts.user.to_account_info();
            let mut vault_lamports = vault_ai.try_borrow_mut_lamports()?;
            let mut user_lamports = user_ai.try_borrow_mut_lamports()?;
            let new_vault = (*vault_lamports)
                .checked_sub(payout_u64)
                .ok_or(MeltError::MathOverflow)?;
            let new_user = (*user_lamports)
                .checked_add(payout_u64)
                .ok_or(MeltError::MathOverflow)?;
            **vault_lamports = new_vault;
            **user_lamports = new_user;
        }

        ur.claimed = true;
        emit!(Claimed {
            user: ctx.accounts.user.key(),
            round: round.key(),
            payout: payout_u64,
        });
        Ok(())
    }
}

struct RoundStartInfo {
    seq: u64,
    start_ts: i64,
    end_ts: i64,
    pot: u64,
    v_pay: u64,
}

fn try_start_round(
    cfg: &mut Account<MeltConfig>,
    round: &mut Account<MeltRound>,
    bumps: &BTreeMap<String, u8>,
    strict: bool,
) -> Result<Option<RoundStartInfo>> {
    if cfg.active_round_active {
        return if strict {
            err!(MeltError::RoundAlreadyActive)
        } else {
            Ok(None)
        };
    }
    if cfg.vial_lamports < cfg.vault_cap_lamports {
        return if strict {
            err!(MeltError::VialNotFull)
        } else {
            Ok(None)
        };
    }

    let now = Clock::get()?.unix_timestamp;
    let duration = if cfg.pending_window_sec > 0 {
        cfg.pending_window_sec
    } else {
        cfg.round_window_sec
    };

    let pot = cfg
        .vault_cap_lamports
        .checked_add(cfg.bonus_pool_lamports)
        .ok_or(MeltError::MathOverflow)?;
    let pay_bps = 10_000u128
        .checked_sub(cfg.rollover_bps as u128)
        .ok_or(MeltError::MathOverflow)?;
    let v_pay = (pot as u128)
        .checked_mul(pay_bps)
        .ok_or(MeltError::MathOverflow)?
        .checked_div(10_000u128)
        .ok_or(MeltError::MathOverflow)?;

    cfg.vial_lamports = cfg
        .vial_lamports
        .checked_sub(cfg.vault_cap_lamports)
        .ok_or(MeltError::MathOverflow)?;
    cfg.bonus_pool_lamports = 0;

    let seq = cfg.round_seq;
    let start_ts = now;
    let end_ts = now
        .checked_add(duration as i64)
        .ok_or(MeltError::MathOverflow)?;
    let v_pay_u64 = u64::try_from(v_pay).map_err(|_| MeltError::MathOverflow)?;

    round.seq = seq;
    round.start_ts = start_ts;
    round.end_ts = end_ts;
    round.v_round = pot;
    round.v_pay = v_pay_u64;
    round.total_burn = 0;
    round.status = RoundStatus::Active;
    round.bump = *bumps.get("round").unwrap();

    cfg.active_round_seq = seq;
    cfg.active_round_active = true;
    cfg.round_seq = cfg.round_seq.checked_add(1).ok_or(MeltError::MathOverflow)?;
    cfg.pending_window_sec = 0;
    Ok(Some(RoundStartInfo {
        seq,
        start_ts,
        end_ts,
        pot,
        v_pay: v_pay_u64,
    }))
}

fn finalize_active_round_if_ended(
    cfg: &mut Account<MeltConfig>,
    round: &mut Account<MeltRound>,
    now: i64,
) -> Result<u64> {
    require!(round.status == RoundStatus::Active, MeltError::BadRoundStatus);
    require!(cfg.active_round_active, MeltError::BadRoundStatus);
    require!(round.seq == cfg.active_round_seq, MeltError::InvalidParams);
    require!(now > round.end_ts, MeltError::RoundNotEnded);

    let rollover = round
        .v_round
        .checked_sub(round.v_pay)
        .ok_or(MeltError::MathOverflow)?;
    cfg.bonus_pool_lamports = cfg
        .bonus_pool_lamports
        .checked_add(rollover)
        .ok_or(MeltError::MathOverflow)?;
    round.status = RoundStatus::Finalized;
    cfg.active_round_active = false;
    Ok(rollover)
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitMeltParams {
    /// Vault cap in lamports (XNT base units, 1e9).
    pub vault_cap_xnt: u64,
    /// Rollover in bps (0..=10000).
    pub rollover_bps: u16,
    /// Minimum burn amount in MIND base units.
    pub burn_min: u64,
    /// Round window duration.
    pub round_window_sec: u64,
    /// Enable test-only admin withdraw.
    pub test_mode: bool,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct AdminSetParamsParams {
    pub vault_cap_xnt: Option<u64>,
    pub rollover_bps: Option<u16>,
    pub burn_min: Option<u64>,
    pub round_window_sec: Option<u64>,
}

#[account]
#[derive(InitSpace)]
pub struct MeltConfig {
    pub admin: Pubkey,
    pub mind_mint: Pubkey,
    pub vault: Pubkey,
    pub vault_cap_lamports: u64,
    pub rollover_bps: u16,
    pub burn_min: u64,
    pub round_window_sec: u64,
    pub test_mode: bool,
    pub round_seq: u64,
    pub vial_lamports: u64,
    pub bonus_pool_lamports: u64,
    pub active_round_seq: u64,
    pub active_round_active: bool,
    pub pending_window_sec: u64,
    pub bump_config: u8,
    pub bump_vault: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
pub struct MeltConfigLegacyV1 {
    pub admin: Pubkey,
    pub mind_mint: Pubkey,
    pub vault: Pubkey,
    pub vault_cap_lamports: u64,
    pub rollover_bps: u16,
    pub burn_min: u64,
    pub round_window_sec: u64,
    pub test_mode: bool,
    pub round_seq: u64,
    pub bump_config: u8,
    pub bump_vault: u8,
}

#[account]
#[derive(InitSpace)]
pub struct MeltVault {
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, InitSpace)]
pub enum RoundStatus {
    Planned,
    Active,
    Finalized,
}

#[account]
#[derive(InitSpace)]
pub struct MeltRound {
    pub seq: u64,
    pub start_ts: i64,
    pub end_ts: i64,
    pub v_round: u64,
    pub v_pay: u64,
    pub total_burn: u64,
    pub status: RoundStatus,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct MeltUserRound {
    pub user: Pubkey,
    pub round: Pubkey,
    pub burned: u64,
    pub claimed: bool,
    pub bump: u8,
}

#[derive(Accounts)]
#[instruction(params: InitMeltParams)]
pub struct InitMelt<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub mind_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = payer,
        space = 8 + MeltConfig::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, MeltConfig>,

    /// PDA that will hold native XNT (lamports). Owned by this program.
    #[account(
        init,
        payer = payer,
        space = 8 + MeltVault::INIT_SPACE,
        seeds = [VAULT_SEED],
        bump
    )]
    pub vault: Account<'info, MeltVault>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminSetParams<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump_config)]
    pub config: Account<'info, MeltConfig>,
}

#[derive(Accounts)]
pub struct AdminMigrateConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump
    )]
    /// CHECK: Legacy config migration reads/writes raw bytes.
    pub config: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminTopupVault<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump_config)]
    pub config: Account<'info, MeltConfig>,
    #[account(mut, seeds = [VAULT_SEED], bump = config.bump_vault)]
    pub vault: Account<'info, MeltVault>,
    #[account(
        init_if_needed,
        payer = admin,
        space = 8 + MeltRound::INIT_SPACE,
        seeds = [ROUND_SEED, &config.round_seq.to_le_bytes()],
        bump
    )]
    pub round: Account<'info, MeltRound>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminTopupVial<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump_config)]
    pub config: Account<'info, MeltConfig>,
    #[account(mut, seeds = [VAULT_SEED], bump = config.bump_vault)]
    pub vault: Account<'info, MeltVault>,
    #[account(
        init_if_needed,
        payer = admin,
        space = 8 + MeltRound::INIT_SPACE,
        seeds = [ROUND_SEED, &config.round_seq.to_le_bytes()],
        bump
    )]
    pub round: Account<'info, MeltRound>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RecordFunding<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump_config)]
    pub config: Account<'info, MeltConfig>,
    #[account(mut, seeds = [VAULT_SEED], bump = config.bump_vault)]
    pub vault: Account<'info, MeltVault>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + MeltRound::INIT_SPACE,
        seeds = [ROUND_SEED, &config.round_seq.to_le_bytes()],
        bump
    )]
    pub round: Account<'info, MeltRound>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminWithdrawVault<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump_config)]
    pub config: Account<'info, MeltConfig>,
    #[account(mut, seeds = [VAULT_SEED], bump = config.bump_vault)]
    pub vault: Account<'info, MeltVault>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct StartRound<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump_config)]
    pub config: Account<'info, MeltConfig>,
    #[account(mut, seeds = [VAULT_SEED], bump = config.bump_vault)]
    pub vault: Account<'info, MeltVault>,

    /// Round PDA (seq-based). We create it on demand.
    #[account(
        init_if_needed,
        payer = admin,
        space = 8 + MeltRound::INIT_SPACE,
        seeds = [ROUND_SEED, &config.round_seq.to_le_bytes()],
        bump
    )]
    pub round: Account<'info, MeltRound>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminSetSchedule<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump_config)]
    pub config: Account<'info, MeltConfig>,
    #[account(
        init_if_needed,
        payer = admin,
        space = 8 + MeltRound::INIT_SPACE,
        seeds = [ROUND_SEED, &config.round_seq.to_le_bytes()],
        bump
    )]
    pub round: Account<'info, MeltRound>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct BurnMind<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump_config)]
    pub config: Account<'info, MeltConfig>,

    #[account(mut, seeds = [ROUND_SEED, &round.seq.to_le_bytes()], bump = round.bump)]
    pub round: Account<'info, MeltRound>,

    #[account(mut, address = config.mind_mint)]
    pub mind_mint: Account<'info, Mint>,

    #[account(
        mut,
        constraint = user_mind_ata.owner == user.key(),
        constraint = user_mind_ata.mint == mind_mint.key()
    )]
    pub user_mind_ata: Account<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = user,
        space = 8 + MeltUserRound::INIT_SPACE,
        seeds = [USER_ROUND_SEED, user.key().as_ref(), round.key().as_ref()],
        bump
    )]
    pub user_round: Account<'info, MeltUserRound>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FinalizeRound<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump_config)]
    pub config: Account<'info, MeltConfig>,
    #[account(mut, seeds = [ROUND_SEED, &round.seq.to_le_bytes()], bump = round.bump)]
    pub round: Account<'info, MeltRound>,
    #[account(seeds = [VAULT_SEED], bump = config.bump_vault)]
    pub vault: Account<'info, MeltVault>,
    #[account(
        init_if_needed,
        payer = admin,
        space = 8 + MeltRound::INIT_SPACE,
        seeds = [ROUND_SEED, &config.round_seq.to_le_bytes()],
        bump
    )]
    pub next_round: Account<'info, MeltRound>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump_config)]
    pub config: Account<'info, MeltConfig>,

    #[account(mut, seeds = [VAULT_SEED], bump = config.bump_vault)]
    pub vault: Account<'info, MeltVault>,

    #[account(mut, seeds = [ROUND_SEED, &round.seq.to_le_bytes()], bump = round.bump)]
    pub round: Account<'info, MeltRound>,
    #[account(
        init_if_needed,
        payer = user,
        space = 8 + MeltRound::INIT_SPACE,
        seeds = [ROUND_SEED, &config.round_seq.to_le_bytes()],
        bump
    )]
    pub next_round: Account<'info, MeltRound>,

    #[account(mut, seeds = [USER_ROUND_SEED, user.key().as_ref(), round.key().as_ref()], bump = user_round.bump)]
    pub user_round: Account<'info, MeltUserRound>,

    pub system_program: Program<'info, System>,
}

#[event]
pub struct FundingRecorded {
    pub amount: u64,
    pub vial_lamports: u64,
}

#[event]
pub struct RoundStarted {
    pub seq: u64,
    pub start_ts: i64,
    pub end_ts: i64,
    pub pot: u64,
    pub v_pay: u64,
}

#[event]
pub struct Burned {
    pub user: Pubkey,
    pub round: Pubkey,
    pub amount: u64,
    pub total_burn: u64,
}

#[event]
pub struct Finalized {
    pub seq: u64,
    pub rollover: u64,
}

#[event]
pub struct Claimed {
    pub user: Pubkey,
    pub round: Pubkey,
    pub payout: u64,
}

#[error_code]
pub enum MeltError {
    #[msg("unauthorized")]
    Unauthorized,
    #[msg("invalid params")]
    InvalidParams,
    #[msg("math overflow")]
    MathOverflow,
    #[msg("round is not active")]
    RoundNotActive,
    #[msg("round not ended")]
    RoundNotEnded,
    #[msg("round not started yet")]
    RoundNotStarted,
    #[msg("round already active")]
    RoundAlreadyActive,
    #[msg("vial not full")]
    VialNotFull,
    #[msg("bad round status")]
    BadRoundStatus,
    #[msg("below burn min")]
    BelowBurnMin,
    #[msg("already claimed")]
    AlreadyClaimed,
    #[msg("nothing to claim")]
    NothingToClaim,
    #[msg("admin withdraw disabled")]
    WithdrawDisabled,
    #[msg("insufficient vault balance")]
    InsufficientVaultBalance,
}

fn migrate_melt_config_account(
    admin_ai: &AccountInfo,
    config_ai: &AccountInfo,
) -> Result<()> {
    require_keys_eq!(*config_ai.owner, crate::id(), MeltError::InvalidParams);
    let new_cfg = {
        let data = config_ai.try_borrow_data()?;
        require!(data.len() >= 8, MeltError::InvalidParams);
        require!(
            data[..8] == MeltConfig::DISCRIMINATOR,
            MeltError::InvalidParams
        );
        let payload = &data[8..];
        if payload.len() == MeltConfig::INIT_SPACE {
            MeltConfig::try_from_slice(payload).map_err(|_| MeltError::InvalidParams)?
        } else if payload.len() == MeltConfigLegacyV1::INIT_SPACE {
            let old = MeltConfigLegacyV1::try_from_slice(payload)
                .map_err(|_| MeltError::InvalidParams)?;
            MeltConfig {
                admin: old.admin,
                mind_mint: old.mind_mint,
                vault: old.vault,
                vault_cap_lamports: old.vault_cap_lamports,
                rollover_bps: old.rollover_bps,
                burn_min: old.burn_min,
                round_window_sec: old.round_window_sec,
                test_mode: old.test_mode,
                round_seq: old.round_seq,
                vial_lamports: 0,
                bonus_pool_lamports: 0,
                active_round_seq: 0,
                active_round_active: false,
                pending_window_sec: 0,
                bump_config: old.bump_config,
                bump_vault: old.bump_vault,
            }
        } else {
            return err!(MeltError::InvalidParams);
        }
    };

    require_keys_eq!(new_cfg.admin, *admin_ai.key, MeltError::Unauthorized);

    let new_len = 8 + MeltConfig::INIT_SPACE;
    if config_ai.data_len() < new_len {
        let rent_min = Rent::get()?.minimum_balance(new_len);
        let current = config_ai.lamports();
        require!(current >= rent_min, MeltError::InsufficientVaultBalance);
        config_ai.realloc(new_len, false)?;
    }

    let mut out = vec![0u8; new_len];
    out[..8].copy_from_slice(&MeltConfig::DISCRIMINATOR);
    let body = new_cfg
        .try_to_vec()
        .map_err(|_| MeltError::InvalidParams)?;
    require!(body.len() == MeltConfig::INIT_SPACE, MeltError::InvalidParams);
    out[8..].copy_from_slice(&body);
    config_ai.try_borrow_mut_data()?.copy_from_slice(&out);
    Ok(())
}
