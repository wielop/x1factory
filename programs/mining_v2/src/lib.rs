use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount, Transfer};
use solana_program::program_option::COption;

declare_id!("uaDkkJGLLEY3kFMhhvrh5MZJ6fmwCmhNf8L7BZQJ9Aw");

const CONFIG_SEED: &[u8] = b"config";
const VAULT_SEED: &[u8] = b"vault";
const POSITION_SEED: &[u8] = b"position";
const PROFILE_SEED: &[u8] = b"profile";
const STAKE_SEED: &[u8] = b"stake";

const BPS_DENOMINATOR: u128 = 10_000;
const ACC_SCALE: u128 = 1_000_000_000_000_000_000;
const SECONDS_PER_DAY_DEFAULT: u64 = 86_400;
const STAKING_SHARE_BPS: u128 = 3_000; // 30%
const BADGE_BONUS_CAP_BPS: u16 = 2_000; // 20%

#[program]
pub mod mining_v2 {
    use super::*;

    pub fn init_config(ctx: Context<InitConfig>, params: InitConfigParams) -> Result<()> {
        require!(params.emission_per_sec > 0, ErrorCode::InvalidAmount);
        require!(params.max_effective_hp > 0, ErrorCode::InvalidAmount);
        let seconds_per_day = if params.seconds_per_day == 0 {
            SECONDS_PER_DAY_DEFAULT
        } else {
            params.seconds_per_day
        };
        require!(seconds_per_day > 0, ErrorCode::InvalidAmount);

        require!(
            ctx.accounts.mind_mint.mint_authority == COption::Some(ctx.accounts.vault_authority.key()),
            ErrorCode::InvalidMintAuthority
        );

        let now = Clock::get()?.unix_timestamp;
        let bumps = ConfigBumps {
            config: *ctx.bumps.get("config").unwrap(),
            vault_authority: *ctx.bumps.get("vault_authority").unwrap(),
        };

        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.emission_per_sec = params.emission_per_sec;
        config.acc_mind_per_hp = 0;
        config.last_update_ts = now;
        config.network_hp_active = 0;
        config.mind_mint = ctx.accounts.mind_mint.key();
        config.xnt_mint = ctx.accounts.xnt_mint.key();
        config.staking_reward_vault = ctx.accounts.staking_reward_vault.key();
        config.treasury_vault = ctx.accounts.treasury_vault.key();
        config.staking_mind_vault = ctx.accounts.staking_mind_vault.key();
        config.max_effective_hp = params.max_effective_hp;
        config.seconds_per_day = seconds_per_day;

        config.staking_acc_xnt_per_mind = 0;
        config.staking_last_update_ts = now;
        config.staking_reward_rate_xnt_per_sec = 0;
        config.staking_epoch_end_ts = now;
        config.staking_total_staked_mind = 0;
        config.staking_undistributed_xnt = 0;
        config.staking_accounted_balance = 0;
        config.bumps = bumps;

        emit!(ConfigInitialized {
            admin: config.admin,
            emission_per_sec: config.emission_per_sec,
            max_effective_hp: config.max_effective_hp,
        });
        Ok(())
    }

    pub fn buy_contract(ctx: Context<BuyContract>, contract_type: u8, position_index: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let cfg = &mut ctx.accounts.config;
        update_mining_global(cfg, now)?;

        if ctx.accounts.user_profile.owner == Pubkey::default() {
            ctx.accounts.user_profile.owner = ctx.accounts.owner.key();
            ctx.accounts.user_profile.next_position_index = 0;
            ctx.accounts.user_profile.active_hp = 0;
            ctx.accounts.user_profile.xp = 0;
            ctx.accounts.user_profile.badge_tier = 0;
            ctx.accounts.user_profile.badge_bonus_bps = 0;
            ctx.accounts.user_profile.bump = *ctx.bumps.get("user_profile").unwrap();
        }
        require_keys_eq!(
            ctx.accounts.user_profile.owner,
            ctx.accounts.owner.key(),
            ErrorCode::Unauthorized
        );
        require!(
            position_index == ctx.accounts.user_profile.next_position_index,
            ErrorCode::InvalidPositionIndex
        );

        let (duration_days, hp, cost_base) =
            contract_terms(contract_type, ctx.accounts.xnt_mint.decimals)?;
        let seconds_per_day = cfg.seconds_per_day;
        let duration_seconds = (duration_days as i64)
            .checked_mul(seconds_per_day as i64)
            .ok_or(ErrorCode::MathOverflow)?;

        let new_active_hp = ctx
            .accounts
            .user_profile
            .active_hp
            .checked_add(hp)
            .ok_or(ErrorCode::MathOverflow)?;
        require!(
            new_active_hp <= cfg.max_effective_hp,
            ErrorCode::MaxEffectiveHpExceeded
        );

        let reward_debt = earned_per_hp(hp, cfg.acc_mind_per_hp)?;
        let position = &mut ctx.accounts.position;
        position.owner = ctx.accounts.owner.key();
        position.hp = hp;
        position.start_ts = now;
        position.end_ts = now
            .checked_add(duration_seconds)
            .ok_or(ErrorCode::MathOverflow)?;
        position.reward_debt = reward_debt;
        position.final_acc_mind_per_hp = 0;
        position.deactivated = false;
        position.bump = *ctx.bumps.get("position").unwrap();

        ctx.accounts.user_profile.active_hp = new_active_hp;
        cfg.network_hp_active = cfg
            .network_hp_active
            .checked_add(hp)
            .ok_or(ErrorCode::MathOverflow)?;

        let staking_share = (cost_base as u128)
            .checked_mul(STAKING_SHARE_BPS)
            .ok_or(ErrorCode::MathOverflow)?
            .checked_div(BPS_DENOMINATOR)
            .ok_or(ErrorCode::MathOverflow)? as u64;
        let treasury_share = cost_base
            .checked_sub(staking_share)
            .ok_or(ErrorCode::MathOverflow)?;

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.owner_xnt_ata.to_account_info(),
                    to: ctx.accounts.treasury_vault.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                },
            ),
            treasury_share,
        )?;
        if staking_share > 0 {
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.owner_xnt_ata.to_account_info(),
                        to: ctx.accounts.staking_reward_vault.to_account_info(),
                        authority: ctx.accounts.owner.to_account_info(),
                    },
                ),
                staking_share,
            )?;
            cfg.staking_undistributed_xnt = cfg
                .staking_undistributed_xnt
                .checked_add(staking_share)
                .ok_or(ErrorCode::MathOverflow)?;
            cfg.staking_accounted_balance = cfg
                .staking_accounted_balance
                .checked_add(staking_share)
                .ok_or(ErrorCode::MathOverflow)?;
        }

        ctx.accounts.user_profile.next_position_index = ctx
            .accounts
            .user_profile
            .next_position_index
            .checked_add(1)
            .ok_or(ErrorCode::MathOverflow)?;

        emit!(ContractPurchased {
            owner: position.owner,
            hp,
            duration_days,
            cost_base,
        });
        Ok(())
    }

    pub fn claim_mind(ctx: Context<ClaimMind>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let cfg = &mut ctx.accounts.config;
        let position = &mut ctx.accounts.position;

        require_keys_eq!(position.owner, ctx.accounts.owner.key(), ErrorCode::Unauthorized);

        if !position.deactivated && now >= position.end_ts {
            finalize_position(cfg, position, &mut ctx.accounts.user_profile, now)?;
        } else {
            update_mining_global(cfg, now)?;
        }

        let acc_used = if position.deactivated {
            position.final_acc_mind_per_hp
        } else {
            cfg.acc_mind_per_hp
        };
        let pending = pending_mind(position.hp, acc_used, position.reward_debt)?;
        require!(pending > 0, ErrorCode::NothingToClaim);
        let reward = u64::try_from(pending).map_err(|_| ErrorCode::MathOverflow)?;

        let signer_seeds: &[&[u8]] = &[VAULT_SEED, &[cfg.bumps.vault_authority]];
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.mind_mint.to_account_info(),
                    to: ctx.accounts.user_mind_ata.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                &[signer_seeds],
            ),
            reward,
        )?;

        position.reward_debt = earned_per_hp(position.hp, acc_used)?;

        emit!(MindClaimed {
            owner: position.owner,
            amount: reward,
        });
        Ok(())
    }

    pub fn deactivate_position(ctx: Context<DeactivatePosition>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let cfg = &mut ctx.accounts.config;
        let position = &mut ctx.accounts.position;

        require!(now >= position.end_ts, ErrorCode::PositionNotExpired);
        if position.deactivated {
            return Ok(());
        }

        finalize_position(cfg, position, &mut ctx.accounts.user_profile, now)?;
        Ok(())
    }

    pub fn stake_mind(ctx: Context<StakeMind>, amount: u64) -> Result<()> {
        require!(amount > 0, ErrorCode::InvalidAmount);
        let now = Clock::get()?.unix_timestamp;
        let cfg = &mut ctx.accounts.config;
        update_staking_global(cfg, now)?;

        if ctx.accounts.user_profile.owner == Pubkey::default() {
            ctx.accounts.user_profile.owner = ctx.accounts.owner.key();
            ctx.accounts.user_profile.next_position_index = 0;
            ctx.accounts.user_profile.active_hp = 0;
            ctx.accounts.user_profile.xp = 0;
            ctx.accounts.user_profile.badge_tier = 0;
            ctx.accounts.user_profile.badge_bonus_bps = 0;
            ctx.accounts.user_profile.bump = *ctx.bumps.get("user_profile").unwrap();
        }
        require_keys_eq!(
            ctx.accounts.user_profile.owner,
            ctx.accounts.owner.key(),
            ErrorCode::Unauthorized
        );

        if ctx.accounts.user_stake.owner == Pubkey::default() {
            ctx.accounts.user_stake.owner = ctx.accounts.owner.key();
            ctx.accounts.user_stake.staked_mind = 0;
            ctx.accounts.user_stake.reward_debt = 0;
            ctx.accounts.user_stake.reward_owed = 0;
            ctx.accounts.user_stake.bump = *ctx.bumps.get("user_stake").unwrap();
        }
        require_keys_eq!(ctx.accounts.user_stake.owner, ctx.accounts.owner.key(), ErrorCode::Unauthorized);

        accrue_staking_owed(cfg, &mut ctx.accounts.user_stake)?;

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.owner_mind_ata.to_account_info(),
                    to: ctx.accounts.staking_mind_vault.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                },
            ),
            amount,
        )?;

        ctx.accounts.user_stake.staked_mind = ctx
            .accounts
            .user_stake
            .staked_mind
            .checked_add(amount)
            .ok_or(ErrorCode::MathOverflow)?;
        cfg.staking_total_staked_mind = cfg
            .staking_total_staked_mind
            .checked_add(amount)
            .ok_or(ErrorCode::MathOverflow)?;
        ctx.accounts.user_stake.reward_debt = earned_per_stake(
            ctx.accounts.user_stake.staked_mind,
            cfg.staking_acc_xnt_per_mind,
        )?;

        emit!(MindStaked {
            owner: ctx.accounts.owner.key(),
            amount,
        });
        Ok(())
    }

    pub fn unstake_mind(ctx: Context<UnstakeMind>, amount: u64) -> Result<()> {
        require!(amount > 0, ErrorCode::InvalidAmount);
        let now = Clock::get()?.unix_timestamp;
        let cfg = &mut ctx.accounts.config;
        update_staking_global(cfg, now)?;

        require!(
            ctx.accounts.user_stake.staked_mind >= amount,
            ErrorCode::InsufficientStake
        );

        accrue_staking_owed(cfg, &mut ctx.accounts.user_stake)?;

        ctx.accounts.user_stake.staked_mind = ctx
            .accounts
            .user_stake
            .staked_mind
            .checked_sub(amount)
            .ok_or(ErrorCode::MathOverflow)?;
        cfg.staking_total_staked_mind = cfg
            .staking_total_staked_mind
            .checked_sub(amount)
            .ok_or(ErrorCode::MathOverflow)?;

        let signer_seeds: &[&[u8]] = &[VAULT_SEED, &[cfg.bumps.vault_authority]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.staking_mind_vault.to_account_info(),
                    to: ctx.accounts.owner_mind_ata.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                &[signer_seeds],
            ),
            amount,
        )?;

        ctx.accounts.user_stake.reward_debt = earned_per_stake(
            ctx.accounts.user_stake.staked_mind,
            cfg.staking_acc_xnt_per_mind,
        )?;

        emit!(MindUnstaked {
            owner: ctx.accounts.owner.key(),
            amount,
        });
        Ok(())
    }

    pub fn claim_xnt(ctx: Context<ClaimXnt>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let cfg = &mut ctx.accounts.config;
        update_staking_global(cfg, now)?;

        let pending_base = pending_stake(cfg, &ctx.accounts.user_stake)?;
        let base_total = pending_base
            .checked_add(ctx.accounts.user_stake.reward_owed as u128)
            .ok_or(ErrorCode::MathOverflow)?;
        require!(base_total > 0, ErrorCode::NothingToClaim);

        let bonus_bps = ctx
            .accounts
            .user_profile
            .badge_bonus_bps
            .min(BADGE_BONUS_CAP_BPS) as u128;
        let payout = base_total
            .checked_mul(BPS_DENOMINATOR + bonus_bps)
            .ok_or(ErrorCode::MathOverflow)?
            .checked_div(BPS_DENOMINATOR)
            .ok_or(ErrorCode::MathOverflow)?;
        let payout_u64 = u64::try_from(payout).map_err(|_| ErrorCode::MathOverflow)?;

        require!(
            ctx.accounts.staking_reward_vault.amount >= payout_u64,
            ErrorCode::InsufficientVaultBalance
        );

        let signer_seeds: &[&[u8]] = &[VAULT_SEED, &[cfg.bumps.vault_authority]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.staking_reward_vault.to_account_info(),
                    to: ctx.accounts.owner_xnt_ata.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                &[signer_seeds],
            ),
            payout_u64,
        )?;

        ctx.accounts.user_stake.reward_owed = 0;
        ctx.accounts.user_stake.reward_debt =
            earned_per_stake(ctx.accounts.user_stake.staked_mind, cfg.staking_acc_xnt_per_mind)?;

        cfg.staking_accounted_balance = cfg
            .staking_accounted_balance
            .checked_sub(payout_u64)
            .ok_or(ErrorCode::MathOverflow)?;

        emit!(XntClaimed {
            owner: ctx.accounts.owner.key(),
            amount: payout_u64,
            bonus_bps: bonus_bps as u16,
        });
        Ok(())
    }

    pub fn roll_epoch(ctx: Context<RollEpoch>, epoch_seconds: u64) -> Result<()> {
        require!(epoch_seconds > 0, ErrorCode::InvalidAmount);
        let now = Clock::get()?.unix_timestamp;
        let cfg = &mut ctx.accounts.config;
        update_staking_global(cfg, now)?;

        let vault_balance = ctx.accounts.staking_reward_vault.amount;
        if vault_balance > cfg.staking_accounted_balance {
            let delta = vault_balance
                .checked_sub(cfg.staking_accounted_balance)
                .ok_or(ErrorCode::MathOverflow)?;
            cfg.staking_undistributed_xnt = cfg
                .staking_undistributed_xnt
                .checked_add(delta)
                .ok_or(ErrorCode::MathOverflow)?;
            cfg.staking_accounted_balance = vault_balance;
        }

        if cfg.staking_total_staked_mind == 0 || cfg.staking_undistributed_xnt == 0 {
            cfg.staking_reward_rate_xnt_per_sec = 0;
            cfg.staking_epoch_end_ts = now;
            cfg.staking_last_update_ts = now;
            return Ok(());
        }

        let rate = cfg
            .staking_undistributed_xnt
            .checked_div(epoch_seconds)
            .ok_or(ErrorCode::MathOverflow)?;
        if rate == 0 {
            cfg.staking_reward_rate_xnt_per_sec = 0;
            cfg.staking_epoch_end_ts = now;
            cfg.staking_last_update_ts = now;
            return Ok(());
        }
        let distributed = rate
            .checked_mul(epoch_seconds)
            .ok_or(ErrorCode::MathOverflow)?;
        cfg.staking_undistributed_xnt = cfg
            .staking_undistributed_xnt
            .checked_sub(distributed)
            .ok_or(ErrorCode::MathOverflow)?;
        cfg.staking_reward_rate_xnt_per_sec = rate;
        cfg.staking_epoch_end_ts = now
            .checked_add(epoch_seconds as i64)
            .ok_or(ErrorCode::MathOverflow)?;
        cfg.staking_last_update_ts = now;

        emit!(EpochRolled {
            rate,
            epoch_end_ts: cfg.staking_epoch_end_ts,
        });
        Ok(())
    }

    pub fn admin_update_config(
        ctx: Context<AdminUpdateConfig>,
        emission_per_sec: u64,
        max_effective_hp: u64,
    ) -> Result<()> {
        require!(emission_per_sec > 0, ErrorCode::InvalidAmount);
        require!(max_effective_hp > 0, ErrorCode::InvalidAmount);
        let cfg = &mut ctx.accounts.config;
        require_keys_eq!(cfg.admin, ctx.accounts.admin.key(), ErrorCode::Unauthorized);
        cfg.emission_per_sec = emission_per_sec;
        cfg.max_effective_hp = max_effective_hp;
        Ok(())
    }

    pub fn admin_set_badge(
        ctx: Context<AdminSetBadge>,
        badge_tier: u8,
        badge_bonus_bps: u16,
    ) -> Result<()> {
        let cfg = &ctx.accounts.config;
        require_keys_eq!(cfg.admin, ctx.accounts.admin.key(), ErrorCode::Unauthorized);
        let profile = &mut ctx.accounts.user_profile;
        if profile.owner == Pubkey::default() {
            profile.owner = ctx.accounts.user.key();
            profile.next_position_index = 0;
            profile.active_hp = 0;
            profile.xp = 0;
            profile.bump = *ctx.bumps.get("user_profile").unwrap();
        }
        require_keys_eq!(profile.owner, ctx.accounts.user.key(), ErrorCode::Unauthorized);
        profile.badge_tier = badge_tier;
        profile.badge_bonus_bps = badge_bonus_bps.min(BADGE_BONUS_CAP_BPS);
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(params: InitConfigParams)]
pub struct InitConfig<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub admin: Signer<'info>,
    /// CHECK: PDA derived from VAULT_SEED/bump used as vault authority.
    #[account(seeds = [VAULT_SEED], bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Box<Account<'info, Config>>,
    #[account(
        constraint = mind_mint.mint_authority == COption::Some(vault_authority.key())
    )]
    pub mind_mint: Account<'info, Mint>,
    pub xnt_mint: Box<Account<'info, Mint>>,
    #[account(
        constraint = staking_reward_vault.owner == vault_authority.key(),
        constraint = staking_reward_vault.mint == xnt_mint.key()
    )]
    pub staking_reward_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        constraint = treasury_vault.owner == vault_authority.key(),
        constraint = treasury_vault.mint == xnt_mint.key()
    )]
    pub treasury_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        constraint = staking_mind_vault.owner == vault_authority.key(),
        constraint = staking_mind_vault.mint == mind_mint.key()
    )]
    pub staking_mind_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitConfigParams {
    pub emission_per_sec: u64,
    pub max_effective_hp: u64,
    pub seconds_per_day: u64,
}

#[derive(Accounts)]
#[instruction(contract_type: u8, position_index: u64)]
pub struct BuyContract<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bumps.config
    )]
    pub config: Box<Account<'info, Config>>,
    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + UserMiningProfile::INIT_SPACE,
        seeds = [PROFILE_SEED, owner.key().as_ref()],
        bump
    )]
    pub user_profile: Box<Account<'info, UserMiningProfile>>,
    #[account(
        init,
        payer = owner,
        space = 8 + MinerPosition::INIT_SPACE,
        seeds = [POSITION_SEED, owner.key().as_ref(), position_index.to_le_bytes().as_ref()],
        bump
    )]
    pub position: Box<Account<'info, MinerPosition>>,
    #[account(seeds = [VAULT_SEED], bump = config.bumps.vault_authority)]
    /// CHECK: PDA derived from VAULT_SEED/bump used as vault authority.
    pub vault_authority: UncheckedAccount<'info>,
    #[account(mut, constraint = xnt_mint.key() == config.xnt_mint)]
    pub xnt_mint: Account<'info, Mint>,
    #[account(
        mut,
        constraint = staking_reward_vault.key() == config.staking_reward_vault,
        constraint = staking_reward_vault.owner == vault_authority.key(),
        constraint = staking_reward_vault.mint == xnt_mint.key()
    )]
    pub staking_reward_vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = treasury_vault.key() == config.treasury_vault,
        constraint = treasury_vault.owner == vault_authority.key(),
        constraint = treasury_vault.mint == xnt_mint.key()
    )]
    pub treasury_vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = owner_xnt_ata.owner == owner.key(),
        constraint = owner_xnt_ata.mint == xnt_mint.key()
    )]
    pub owner_xnt_ata: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimMind<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bumps.config
    )]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut,
        seeds = [PROFILE_SEED, owner.key().as_ref()],
        bump = user_profile.bump
    )]
    pub user_profile: Box<Account<'info, UserMiningProfile>>,
    #[account(mut, constraint = position.owner == owner.key())]
    pub position: Box<Account<'info, MinerPosition>>,
    #[account(seeds = [VAULT_SEED], bump = config.bumps.vault_authority)]
    /// CHECK: PDA derived from VAULT_SEED/bump used as vault authority.
    pub vault_authority: UncheckedAccount<'info>,
    #[account(
        mut,
        constraint = mind_mint.key() == config.mind_mint
    )]
    pub mind_mint: Account<'info, Mint>,
    #[account(
        mut,
        constraint = user_mind_ata.owner == owner.key(),
        constraint = user_mind_ata.mint == mind_mint.key()
    )]
    pub user_mind_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct DeactivatePosition<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bumps.config
    )]
    pub config: Box<Account<'info, Config>>,
    #[account(mut)]
    pub position: Box<Account<'info, MinerPosition>>,
    #[account(
        mut,
        seeds = [PROFILE_SEED, position.owner.as_ref()],
        bump = user_profile.bump
    )]
    pub user_profile: Box<Account<'info, UserMiningProfile>>,
}

#[derive(Accounts)]
pub struct StakeMind<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bumps.config
    )]
    pub config: Box<Account<'info, Config>>,
    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + UserMiningProfile::INIT_SPACE,
        seeds = [PROFILE_SEED, owner.key().as_ref()],
        bump
    )]
    pub user_profile: Box<Account<'info, UserMiningProfile>>,
    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + UserStake::INIT_SPACE,
        seeds = [STAKE_SEED, owner.key().as_ref()],
        bump
    )]
    pub user_stake: Box<Account<'info, UserStake>>,
    #[account(seeds = [VAULT_SEED], bump = config.bumps.vault_authority)]
    /// CHECK: PDA derived from VAULT_SEED/bump used as vault authority.
    pub vault_authority: UncheckedAccount<'info>,
    #[account(
        mut,
        constraint = staking_mind_vault.key() == config.staking_mind_vault,
        constraint = staking_mind_vault.owner == vault_authority.key(),
        constraint = staking_mind_vault.mint == config.mind_mint
    )]
    pub staking_mind_vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = owner_mind_ata.owner == owner.key(),
        constraint = owner_mind_ata.mint == config.mind_mint
    )]
    pub owner_mind_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UnstakeMind<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bumps.config
    )]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut,
        seeds = [STAKE_SEED, owner.key().as_ref()],
        bump = user_stake.bump,
        constraint = user_stake.owner == owner.key()
    )]
    pub user_stake: Box<Account<'info, UserStake>>,
    #[account(seeds = [VAULT_SEED], bump = config.bumps.vault_authority)]
    /// CHECK: PDA derived from VAULT_SEED/bump used as vault authority.
    pub vault_authority: UncheckedAccount<'info>,
    #[account(
        mut,
        constraint = staking_mind_vault.key() == config.staking_mind_vault,
        constraint = staking_mind_vault.owner == vault_authority.key(),
        constraint = staking_mind_vault.mint == config.mind_mint
    )]
    pub staking_mind_vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = owner_mind_ata.owner == owner.key(),
        constraint = owner_mind_ata.mint == config.mind_mint
    )]
    pub owner_mind_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ClaimXnt<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bumps.config
    )]
    pub config: Box<Account<'info, Config>>,
    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + UserMiningProfile::INIT_SPACE,
        seeds = [PROFILE_SEED, owner.key().as_ref()],
        bump
    )]
    pub user_profile: Box<Account<'info, UserMiningProfile>>,
    #[account(
        mut,
        seeds = [STAKE_SEED, owner.key().as_ref()],
        bump = user_stake.bump,
        constraint = user_stake.owner == owner.key()
    )]
    pub user_stake: Box<Account<'info, UserStake>>,
    #[account(seeds = [VAULT_SEED], bump = config.bumps.vault_authority)]
    /// CHECK: PDA derived from VAULT_SEED/bump used as vault authority.
    pub vault_authority: UncheckedAccount<'info>,
    #[account(
        mut,
        constraint = staking_reward_vault.key() == config.staking_reward_vault,
        constraint = staking_reward_vault.owner == vault_authority.key(),
        constraint = staking_reward_vault.mint == config.xnt_mint
    )]
    pub staking_reward_vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = owner_xnt_ata.owner == owner.key(),
        constraint = owner_xnt_ata.mint == config.xnt_mint
    )]
    pub owner_xnt_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RollEpoch<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bumps.config
    )]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut,
        constraint = staking_reward_vault.key() == config.staking_reward_vault
    )]
    pub staking_reward_vault: Account<'info, TokenAccount>,
}

#[derive(Accounts)]
pub struct AdminUpdateConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bumps.config
    )]
    pub config: Box<Account<'info, Config>>,
}

#[derive(Accounts)]
pub struct AdminSetBadge<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bumps.config
    )]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: used only for PDA derivation
    pub user: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = admin,
        space = 8 + UserMiningProfile::INIT_SPACE,
        seeds = [PROFILE_SEED, user.key().as_ref()],
        bump
    )]
    pub user_profile: Box<Account<'info, UserMiningProfile>>,
    pub system_program: Program<'info, System>,
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub emission_per_sec: u64,
    pub acc_mind_per_hp: u128,
    pub last_update_ts: i64,
    pub network_hp_active: u64,
    pub mind_mint: Pubkey,
    pub xnt_mint: Pubkey,
    pub staking_reward_vault: Pubkey,
    pub treasury_vault: Pubkey,
    pub staking_mind_vault: Pubkey,
    pub max_effective_hp: u64,
    pub seconds_per_day: u64,
    pub staking_acc_xnt_per_mind: u128,
    pub staking_last_update_ts: i64,
    pub staking_reward_rate_xnt_per_sec: u64,
    pub staking_epoch_end_ts: i64,
    pub staking_total_staked_mind: u64,
    pub staking_undistributed_xnt: u64,
    pub staking_accounted_balance: u64,
    pub bumps: ConfigBumps,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
pub struct ConfigBumps {
    pub config: u8,
    pub vault_authority: u8,
}

#[account]
#[derive(InitSpace)]
pub struct UserMiningProfile {
    pub owner: Pubkey,
    pub next_position_index: u64,
    pub active_hp: u64,
    pub xp: u64,
    pub badge_tier: u8,
    pub badge_bonus_bps: u16,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct MinerPosition {
    pub owner: Pubkey,
    pub hp: u64,
    pub start_ts: i64,
    pub end_ts: i64,
    pub reward_debt: u128,
    pub final_acc_mind_per_hp: u128,
    pub deactivated: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct UserStake {
    pub owner: Pubkey,
    pub staked_mind: u64,
    pub reward_debt: u128,
    pub reward_owed: u64,
    pub bump: u8,
}

#[event]
pub struct ConfigInitialized {
    pub admin: Pubkey,
    pub emission_per_sec: u64,
    pub max_effective_hp: u64,
}

#[event]
pub struct ContractPurchased {
    pub owner: Pubkey,
    pub hp: u64,
    pub duration_days: u64,
    pub cost_base: u64,
}

#[event]
pub struct MindClaimed {
    pub owner: Pubkey,
    pub amount: u64,
}

#[event]
pub struct MindStaked {
    pub owner: Pubkey,
    pub amount: u64,
}

#[event]
pub struct MindUnstaked {
    pub owner: Pubkey,
    pub amount: u64,
}

#[event]
pub struct XntClaimed {
    pub owner: Pubkey,
    pub amount: u64,
    pub bonus_bps: u16,
}

#[event]
pub struct EpochRolled {
    pub rate: u64,
    pub epoch_end_ts: i64,
}

fn contract_terms(contract_type: u8, xnt_decimals: u8) -> Result<(u64, u64, u64)> {
    let base = ten_pow(xnt_decimals)?;
    match contract_type {
        0 => Ok((7, 1, base)),
        1 => Ok((
            14,
            5,
            base.checked_mul(10).ok_or(ErrorCode::MathOverflow)?,
        )),
        2 => Ok((
            28,
            7,
            base.checked_mul(20).ok_or(ErrorCode::MathOverflow)?,
        )),
        _ => Err(error!(ErrorCode::InvalidContractType)),
    }
}

fn ten_pow(decimals: u8) -> Result<u64> {
    if decimals == 0 {
        return Ok(1);
    }
    Ok(10u64
        .checked_pow(decimals as u32)
        .ok_or(ErrorCode::MathOverflow)?)
}

fn earned_per_hp(hp: u64, acc_mind_per_hp: u128) -> Result<u128> {
    (hp as u128)
        .checked_mul(acc_mind_per_hp)
        .ok_or(ErrorCode::MathOverflow)?
        .checked_div(ACC_SCALE)
        .ok_or(ErrorCode::MathOverflow.into())
}

fn update_mining_global(cfg: &mut Account<Config>, now: i64) -> Result<()> {
    if now <= cfg.last_update_ts {
        return Ok(());
    }
    let dt = now
        .checked_sub(cfg.last_update_ts)
        .ok_or(ErrorCode::MathOverflow)?;
    if cfg.network_hp_active == 0 {
        cfg.last_update_ts = now;
        return Ok(());
    }
    let mintable = (dt as u128)
        .checked_mul(cfg.emission_per_sec as u128)
        .ok_or(ErrorCode::MathOverflow)?;
    let delta = mintable
        .checked_mul(ACC_SCALE)
        .ok_or(ErrorCode::MathOverflow)?
        .checked_div(cfg.network_hp_active as u128)
        .ok_or(ErrorCode::MathOverflow)?;
    cfg.acc_mind_per_hp = cfg
        .acc_mind_per_hp
        .checked_add(delta)
        .ok_or(ErrorCode::MathOverflow)?;
    cfg.last_update_ts = now;
    Ok(())
}

fn finalize_position(
    cfg: &mut Account<Config>,
    position: &mut Account<MinerPosition>,
    user_profile: &mut Account<UserMiningProfile>,
    now: i64,
) -> Result<()> {
    if !position.deactivated && cfg.last_update_ts < position.end_ts {
        update_mining_global(cfg, position.end_ts)?;
    }
    position.final_acc_mind_per_hp = cfg.acc_mind_per_hp;
    position.deactivated = true;
    cfg.network_hp_active = cfg
        .network_hp_active
        .checked_sub(position.hp)
        .ok_or(ErrorCode::MathOverflow)?;
    user_profile.active_hp = user_profile
        .active_hp
        .checked_sub(position.hp)
        .ok_or(ErrorCode::MathOverflow)?;
    update_mining_global(cfg, now)?;
    Ok(())
}

fn pending_mind(hp: u64, acc_mind_per_hp: u128, reward_debt: u128) -> Result<u128> {
    let earned = earned_per_hp(hp, acc_mind_per_hp)?;
    Ok(earned.saturating_sub(reward_debt))
}

fn earned_per_stake(staked: u64, acc_xnt_per_mind: u128) -> Result<u128> {
    (staked as u128)
        .checked_mul(acc_xnt_per_mind)
        .ok_or(ErrorCode::MathOverflow)?
        .checked_div(ACC_SCALE)
        .ok_or(ErrorCode::MathOverflow.into())
}

fn pending_stake(cfg: &Config, user_stake: &UserStake) -> Result<u128> {
    let earned = earned_per_stake(user_stake.staked_mind, cfg.staking_acc_xnt_per_mind)?;
    Ok(earned.saturating_sub(user_stake.reward_debt))
}

fn accrue_staking_owed(cfg: &Config, user_stake: &mut UserStake) -> Result<()> {
    let pending = pending_stake(cfg, user_stake)?;
    if pending == 0 {
        return Ok(());
    }
    let pending_u64 = u64::try_from(pending).map_err(|_| ErrorCode::MathOverflow)?;
    user_stake.reward_owed = user_stake
        .reward_owed
        .checked_add(pending_u64)
        .ok_or(ErrorCode::MathOverflow)?;
    Ok(())
}

fn update_staking_global(cfg: &mut Account<Config>, now: i64) -> Result<()> {
    if now <= cfg.staking_last_update_ts {
        return Ok(());
    }
    if cfg.staking_reward_rate_xnt_per_sec == 0 || cfg.staking_total_staked_mind == 0 {
        cfg.staking_last_update_ts = now;
        return Ok(());
    }
    let effective_end = now.min(cfg.staking_epoch_end_ts);
    if effective_end <= cfg.staking_last_update_ts {
        return Ok(());
    }
    let dt = effective_end
        .checked_sub(cfg.staking_last_update_ts)
        .ok_or(ErrorCode::MathOverflow)?;
    let mintable = (dt as u128)
        .checked_mul(cfg.staking_reward_rate_xnt_per_sec as u128)
        .ok_or(ErrorCode::MathOverflow)?;
    let delta = mintable
        .checked_mul(ACC_SCALE)
        .ok_or(ErrorCode::MathOverflow)?
        .checked_div(cfg.staking_total_staked_mind as u128)
        .ok_or(ErrorCode::MathOverflow)?;
    cfg.staking_acc_xnt_per_mind = cfg
        .staking_acc_xnt_per_mind
        .checked_add(delta)
        .ok_or(ErrorCode::MathOverflow)?;
    cfg.staking_last_update_ts = effective_end;
    Ok(())
}

#[error_code]
pub enum ErrorCode {
    #[msg("Invalid amount")]
    InvalidAmount,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Invalid position index")]
    InvalidPositionIndex,
    #[msg("Max effective HP exceeded")]
    MaxEffectiveHpExceeded,
    #[msg("Nothing to claim")]
    NothingToClaim,
    #[msg("Position not expired")]
    PositionNotExpired,
    #[msg("Invalid mint authority")]
    InvalidMintAuthority,
    #[msg("Insufficient stake balance")]
    InsufficientStake,
    #[msg("Insufficient vault balance")]
    InsufficientVaultBalance,
    #[msg("Invalid contract type")]
    InvalidContractType,
}
