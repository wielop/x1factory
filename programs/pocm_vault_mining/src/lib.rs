use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount, Transfer};
use solana_program::program_option::COption;

declare_id!("4BwetFdBHSkDTAByraaXiiwLFTQ5jj8w4mHGpYMrNn4r");

const CONFIG_SEED: &[u8] = b"config";
const VAULT_SEED: &[u8] = b"vault";
const POSITION_SEED: &[u8] = b"position";
const EPOCH_SEED: &[u8] = b"epoch";
const USER_EPOCH_SEED: &[u8] = b"user_epoch";
const BPS_DENOMINATOR: u128 = 10_000;
const DEFAULT_EPOCH_SECONDS: u64 = 86_400;
const SECONDS_PER_DAY: i64 = 86_400;
const DEFAULT_SOFT_HALVING_DAYS: u64 = 90;
const DEFAULT_SOFT_HALVING_DROP_BPS: u16 = 1_000; // 10%
const DEFAULT_MP_CAP_BPS: u16 = 200; // 2%
const DAILY_EMISSION_TOKENS: u64 = 100_000;

#[program]
pub mod pocm_vault_mining {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, params: InitializeParams) -> Result<()> {
        require!(
            params.mined_cap_pct_bps <= 10_000,
            ErrorCode::InvalidPercentage
        );
        require!(params.total_supply_mind > 0, ErrorCode::InvalidSupply);
        let epoch_seconds = if params.allow_epoch_seconds_edit {
            require!(params.epoch_seconds > 0, ErrorCode::InvalidEpochLength);
            params.epoch_seconds
        } else {
            require!(
                params.epoch_seconds == 0 || params.epoch_seconds == DEFAULT_EPOCH_SECONDS,
                ErrorCode::EpochEditDisabled
            );
            DEFAULT_EPOCH_SECONDS
        };

        require!(
            ctx.accounts.xnt_mint.decimals == params.xnt_decimals,
            ErrorCode::DecimalsMismatch
        );

        let dec_pow = ten_pow(params.mind_decimals)?;
        let daily_emission_initial = DAILY_EMISSION_TOKENS
            .checked_mul(dec_pow)
            .ok_or(ErrorCode::MathOverflow)?;
        let mined_cap = (params.total_supply_mind as u128)
            .checked_mul(params.mined_cap_pct_bps as u128)
            .ok_or(ErrorCode::MathOverflow)?
            .checked_div(BPS_DENOMINATOR)
            .ok_or(ErrorCode::MathOverflow)? as u64;
        require!(mined_cap > 0, ErrorCode::InvalidCap);

        let now = Clock::get()?.unix_timestamp;
        let bumps = ConfigBumps {
            config: ctx.bumps.config,
            vault_authority: ctx.bumps.vault_authority,
        };

        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.xnt_mint = params.xnt_mint;
        config.mind_mint = ctx.accounts.mind_mint.key();
        config.vault_xnt_ata = ctx.accounts.vault_xnt_ata.key();
        config.mind_decimals = params.mind_decimals;
        config.xnt_decimals = params.xnt_decimals;
        config.daily_emission_initial = daily_emission_initial;
        config.daily_emission_current = daily_emission_initial;
        config.epoch_seconds = epoch_seconds;
        config.soft_halving_period_days = DEFAULT_SOFT_HALVING_DAYS;
        config.soft_halving_bps_drop = DEFAULT_SOFT_HALVING_DROP_BPS;
        config.emission_start_ts = now;
        config.last_epoch_ts = now;
        config.mined_total = 0;
        config.mined_cap = mined_cap;
        config.total_supply_mind = params.total_supply_mind;
        config.mp_cap_bps_per_wallet = DEFAULT_MP_CAP_BPS;
        config.th1 = params.th1;
        config.th2 = params.th2;
        config.allow_epoch_seconds_edit = params.allow_epoch_seconds_edit;
        config.bumps = bumps;

        emit!(InitializeEvent {
            admin: config.admin,
            xnt_mint: config.xnt_mint,
            mind_mint: config.mind_mint,
            vault: ctx.accounts.vault_authority.key(),
            epoch_seconds,
            mind_decimals: params.mind_decimals,
            mined_cap,
        });
        Ok(())
    }

    pub fn create_position(ctx: Context<CreatePosition>, duration_days: u16) -> Result<()> {
        let time_multiplier_bps =
            time_multiplier_for_duration(duration_days).ok_or(ErrorCode::InvalidDuration)?;

        let position = &mut ctx.accounts.position;
        position.owner = ctx.accounts.owner.key();
        position.locked_amount = 0;
        position.lock_start_ts = 0;
        position.lock_end_ts = 0;
        position.duration_days = duration_days;
        position.time_multiplier_bps = time_multiplier_bps;
        position.last_active_epoch = 0;
        position.accrued_owed = 0;
        position.last_claimed_epoch = 0;
        position.bump = ctx.bumps.position;

        emit!(PositionCreated {
            owner: position.owner,
            duration_days,
            time_multiplier_bps,
        });
        Ok(())
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(amount > 0, ErrorCode::InvalidAmount);
        let position = &mut ctx.accounts.position;
        require_keys_eq!(
            position.owner,
            ctx.accounts.owner.key(),
            ErrorCode::Unauthorized
        );
        require!(position.locked_amount == 0, ErrorCode::PositionActive);
        require!(
            time_multiplier_for_duration(position.duration_days).is_some(),
            ErrorCode::InvalidDuration
        );
        let cfg = &ctx.accounts.config;
        let lock_day_seconds = if cfg.allow_epoch_seconds_edit {
            cfg.epoch_seconds as i64
        } else {
            SECONDS_PER_DAY
        };
        let now = Clock::get()?.unix_timestamp;
        let lock_duration = (position.duration_days as i64)
            .checked_mul(lock_day_seconds)
            .ok_or(ErrorCode::MathOverflow)?;

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.owner_xnt_ata.to_account_info(),
                    to: ctx.accounts.vault_xnt_ata.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                },
            ),
            amount,
        )?;

        position.locked_amount = amount;
        position.lock_start_ts = now;
        position.lock_end_ts = now
            .checked_add(lock_duration)
            .ok_or(ErrorCode::MathOverflow)?;

        emit!(Deposited {
            owner: position.owner,
            amount,
            lock_end_ts: position.lock_end_ts,
        });
        Ok(())
    }

    pub fn heartbeat(ctx: Context<Heartbeat>, epoch_index: u64) -> Result<()> {
        let config = &mut ctx.accounts.config;
        let position = &mut ctx.accounts.position;
        require_keys_eq!(
            position.owner,
            ctx.accounts.owner.key(),
            ErrorCode::Unauthorized
        );
        require!(position.locked_amount > 0, ErrorCode::InactivePosition);
        let now = Clock::get()?.unix_timestamp;
        require!(now < position.lock_end_ts, ErrorCode::LockExpired);

        let expected_epoch = epoch_index_for_ts(config, now)?;
        require!(epoch_index == expected_epoch, ErrorCode::InvalidEpochIndex);

        let epoch_state = &mut ctx.accounts.epoch_state;
        let is_new_epoch = epoch_state.epoch_index == 0
            && epoch_state.start_ts == 0
            && epoch_state.end_ts == 0
            && epoch_state.total_effective_mp == 0;
        if is_new_epoch {
            epoch_state.epoch_index = epoch_index;
            epoch_state.start_ts = epoch_start_ts(config, epoch_index)?;
            epoch_state.end_ts = epoch_state
                .start_ts
                .checked_add(config.epoch_seconds as i64)
                .ok_or(ErrorCode::MathOverflow)?;
            epoch_state.daily_emission = emission_for_epoch(config, epoch_index)?;
            epoch_state.total_effective_mp = 0;
            epoch_state.finalized = false;
            epoch_state.bump = ctx.bumps.epoch_state;
            config.daily_emission_current = epoch_state.daily_emission;
            config.last_epoch_ts = epoch_state.start_ts;
        } else {
            require!(
                epoch_state.epoch_index == epoch_index,
                ErrorCode::InvalidEpochIndex
            );
        }

        let weighted_amount =
            compute_weighted_amount(position.locked_amount, config.th1, config.th2);
        let user_mp = weighted_amount
            .checked_mul(position.time_multiplier_bps as u128)
            .ok_or(ErrorCode::MathOverflow)?
            .checked_div(BPS_DENOMINATOR)
            .ok_or(ErrorCode::MathOverflow)?;
        require!(user_mp > 0, ErrorCode::ZeroMiningPower);

        epoch_state.total_effective_mp = epoch_state
            .total_effective_mp
            .checked_add(user_mp)
            .ok_or(ErrorCode::MathOverflow)?;

        let user_epoch = &mut ctx.accounts.user_epoch;
        user_epoch.owner = position.owner;
        user_epoch.epoch_index = epoch_index;
        user_epoch.user_mp = user_mp;
        user_epoch.claimed = false;
        user_epoch.bump = ctx.bumps.user_epoch;

        position.last_active_epoch = epoch_index;

        emit!(HeartbeatEvent {
            owner: position.owner,
            epoch_index,
            user_mp,
        });
        Ok(())
    }

    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        let epoch_state = &ctx.accounts.epoch_state;
        let user_epoch = &mut ctx.accounts.user_epoch;
        let position = &mut ctx.accounts.position;
        require_keys_eq!(
            position.owner,
            ctx.accounts.owner.key(),
            ErrorCode::Unauthorized
        );
        require_keys_eq!(user_epoch.owner, position.owner, ErrorCode::Unauthorized);
        require!(!user_epoch.claimed, ErrorCode::AlreadyClaimed);
        require!(epoch_state.total_effective_mp > 0, ErrorCode::NoEpochPower);

        let cap_portion = (epoch_state.total_effective_mp)
            .checked_mul(config.mp_cap_bps_per_wallet as u128)
            .ok_or(ErrorCode::MathOverflow)?
            .checked_div(BPS_DENOMINATOR)
            .ok_or(ErrorCode::MathOverflow)?;
        let capped_user_mp = user_epoch.user_mp.min(cap_portion);
        require!(capped_user_mp > 0, ErrorCode::ZeroMiningPower);

        let reward = (epoch_state.daily_emission as u128)
            .checked_mul(capped_user_mp)
            .ok_or(ErrorCode::MathOverflow)?
            .checked_div(epoch_state.total_effective_mp)
            .ok_or(ErrorCode::MathOverflow)?;
        let remaining = config
            .mined_cap
            .checked_sub(config.mined_total)
            .ok_or(ErrorCode::EmissionDepleted)? as u128;
        let final_reward = reward.min(remaining);
        require!(final_reward > 0, ErrorCode::NothingToClaim);

        let reward_u64 = u64::try_from(final_reward).map_err(|_| ErrorCode::MathOverflow)?;

        let signer_seeds: &[&[u8]] = &[VAULT_SEED, &[config.bumps.vault_authority]];
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
            reward_u64,
        )?;

        user_epoch.claimed = true;
        config.mined_total = config
            .mined_total
            .checked_add(reward_u64)
            .ok_or(ErrorCode::MathOverflow)?;
        position.last_claimed_epoch = epoch_state.epoch_index;

        emit!(Claimed {
            owner: position.owner,
            epoch_index: epoch_state.epoch_index,
            reward: reward_u64,
            capped_user_mp,
            total_epoch_mp: epoch_state.total_effective_mp,
        });
        Ok(())
    }

    pub fn withdraw(ctx: Context<Withdraw>) -> Result<()> {
        let position = &mut ctx.accounts.position;
        require_keys_eq!(
            position.owner,
            ctx.accounts.owner.key(),
            ErrorCode::Unauthorized
        );
        require!(position.locked_amount > 0, ErrorCode::InactivePosition);

        let now = Clock::get()?.unix_timestamp;
        require!(now >= position.lock_end_ts, ErrorCode::LockNotFinished);

        let amount = position.locked_amount;
        let seeds: &[&[u8]] = &[VAULT_SEED, &[ctx.accounts.config.bumps.vault_authority]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault_xnt_ata.to_account_info(),
                    to: ctx.accounts.owner_xnt_ata.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )?;

        position.locked_amount = 0;
        position.lock_start_ts = 0;
        position.lock_end_ts = 0;
        position.last_active_epoch = 0;

        emit!(Withdrawn {
            owner: position.owner,
            amount,
        });
        Ok(())
    }

    pub fn admin_update_config(
        ctx: Context<AdminUpdateConfig>,
        params: AdminUpdateParams,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        require!(
            params.mp_cap_bps_per_wallet <= 10_000,
            ErrorCode::InvalidPercentage
        );
        config.th1 = params.th1;
        config.th2 = params.th2;
        config.mp_cap_bps_per_wallet = params.mp_cap_bps_per_wallet;
        if params.update_epoch_seconds {
            require!(
                config.allow_epoch_seconds_edit,
                ErrorCode::EpochEditDisabled
            );
            require!(params.epoch_seconds > 0, ErrorCode::InvalidEpochLength);
            config.epoch_seconds = params.epoch_seconds;
        }

        emit!(ConfigUpdated {
            admin: config.admin,
            th1: config.th1,
            th2: config.th2,
            mp_cap_bps_per_wallet: config.mp_cap_bps_per_wallet,
            epoch_seconds: config.epoch_seconds,
        });
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(params: InitializeParams)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub admin: Signer<'info>,
    /// CHECK: PDA authority for vaults/minting
    #[account(seeds = [VAULT_SEED], bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, Config>,
    #[account(
        constraint = mind_mint.decimals == params.mind_decimals,
        constraint = mind_mint.mint_authority == COption::Some(vault_authority.key())
    )]
    pub mind_mint: Account<'info, Mint>,
    pub xnt_mint: Account<'info, Mint>,
    #[account(
        constraint = vault_xnt_ata.owner == vault_authority.key(),
        constraint = vault_xnt_ata.mint == xnt_mint.key()
    )]
    pub vault_xnt_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitializeParams {
    pub xnt_mint: Pubkey,
    pub mind_decimals: u8,
    pub xnt_decimals: u8,
    pub total_supply_mind: u64,
    pub mined_cap_pct_bps: u16,
    pub th1: u64,
    pub th2: u64,
    pub allow_epoch_seconds_edit: bool,
    pub epoch_seconds: u64,
}

#[derive(Accounts)]
pub struct CreatePosition<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bumps.config
    )]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = owner,
        space = 8 + UserPosition::INIT_SPACE,
        seeds = [POSITION_SEED, owner.key().as_ref()],
        bump
    )]
    pub position: Account<'info, UserPosition>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    pub owner: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bumps.config
    )]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [POSITION_SEED, owner.key().as_ref()],
        bump = position.bump
    )]
    pub position: Account<'info, UserPosition>,
    #[account(seeds = [VAULT_SEED], bump = config.bumps.vault_authority)]
    /// CHECK: authority PDA
    pub vault_authority: UncheckedAccount<'info>,
    #[account(mut, constraint = xnt_mint.key() == config.xnt_mint)]
    pub xnt_mint: Account<'info, Mint>,
    #[account(
        mut,
        constraint = vault_xnt_ata.key() == config.vault_xnt_ata,
        constraint = vault_xnt_ata.owner == vault_authority.key(),
        constraint = vault_xnt_ata.mint == xnt_mint.key()
    )]
    pub vault_xnt_ata: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = owner_xnt_ata.owner == owner.key(),
        constraint = owner_xnt_ata.mint == xnt_mint.key()
    )]
    pub owner_xnt_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(epoch_index: u64)]
pub struct Heartbeat<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bumps.config
    )]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [POSITION_SEED, owner.key().as_ref()],
        bump = position.bump
    )]
    pub position: Account<'info, UserPosition>,
    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + EpochState::INIT_SPACE,
        seeds = [EPOCH_SEED, epoch_index.to_le_bytes().as_ref()],
        bump
    )]
    pub epoch_state: Account<'info, EpochState>,
    #[account(
        init,
        payer = owner,
        space = 8 + UserEpoch::INIT_SPACE,
        seeds = [USER_EPOCH_SEED, owner.key().as_ref(), epoch_index.to_le_bytes().as_ref()],
        bump
    )]
    pub user_epoch: Account<'info, UserEpoch>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bumps.config
    )]
    pub config: Account<'info, Config>,
    #[account(
        seeds = [VAULT_SEED],
        bump = config.bumps.vault_authority
    )]
    /// CHECK: signer PDA
    pub vault_authority: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [POSITION_SEED, owner.key().as_ref()],
        bump = position.bump,
        constraint = position.owner == owner.key()
    )]
    pub position: Account<'info, UserPosition>,
    #[account(
        mut,
        seeds = [EPOCH_SEED, epoch_state.epoch_index.to_le_bytes().as_ref()],
        bump = epoch_state.bump,
        constraint = epoch_state.epoch_index == user_epoch.epoch_index
    )]
    pub epoch_state: Account<'info, EpochState>,
    #[account(
        mut,
        seeds = [USER_EPOCH_SEED, owner.key().as_ref(), user_epoch.epoch_index.to_le_bytes().as_ref()],
        bump = user_epoch.bump,
        constraint = user_epoch.owner == owner.key()
    )]
    pub user_epoch: Account<'info, UserEpoch>,
    #[account(mut, constraint = mind_mint.key() == config.mind_mint)]
    pub mind_mint: Account<'info, Mint>,
    #[account(
        init_if_needed,
        payer = owner,
        associated_token::mint = mind_mint,
        associated_token::authority = owner
    )]
    pub user_mind_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bumps.config
    )]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [POSITION_SEED, owner.key().as_ref()],
        bump = position.bump
    )]
    pub position: Account<'info, UserPosition>,
    #[account(
        seeds = [VAULT_SEED],
        bump = config.bumps.vault_authority
    )]
    /// CHECK: PDA authority
    pub vault_authority: UncheckedAccount<'info>,
    #[account(mut, constraint = xnt_mint.key() == config.xnt_mint)]
    pub xnt_mint: Account<'info, Mint>,
    #[account(
        mut,
        constraint = vault_xnt_ata.key() == config.vault_xnt_ata,
        constraint = vault_xnt_ata.owner == vault_authority.key(),
        constraint = vault_xnt_ata.mint == xnt_mint.key()
    )]
    pub vault_xnt_ata: Account<'info, TokenAccount>,
    #[account(
        init_if_needed,
        payer = owner,
        associated_token::mint = xnt_mint,
        associated_token::authority = owner
    )]
    pub owner_xnt_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminUpdateConfig<'info> {
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bumps.config,
        has_one = admin
    )]
    pub config: Account<'info, Config>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct AdminUpdateParams {
    pub th1: u64,
    pub th2: u64,
    pub mp_cap_bps_per_wallet: u16,
    pub update_epoch_seconds: bool,
    pub epoch_seconds: u64,
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub xnt_mint: Pubkey,
    pub mind_mint: Pubkey,
    pub vault_xnt_ata: Pubkey,
    pub mind_decimals: u8,
    pub xnt_decimals: u8,
    pub daily_emission_initial: u64,
    pub daily_emission_current: u64,
    pub epoch_seconds: u64,
    pub soft_halving_period_days: u64,
    pub soft_halving_bps_drop: u16,
    pub emission_start_ts: i64,
    pub last_epoch_ts: i64,
    pub mined_total: u64,
    pub mined_cap: u64,
    pub total_supply_mind: u64,
    pub mp_cap_bps_per_wallet: u16,
    pub th1: u64,
    pub th2: u64,
    pub allow_epoch_seconds_edit: bool,
    pub bumps: ConfigBumps,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
pub struct ConfigBumps {
    pub config: u8,
    pub vault_authority: u8,
}

#[account]
#[derive(InitSpace)]
pub struct UserPosition {
    pub owner: Pubkey,
    pub locked_amount: u64,
    pub lock_start_ts: i64,
    pub lock_end_ts: i64,
    pub duration_days: u16,
    pub time_multiplier_bps: u16,
    pub last_active_epoch: u64,
    pub accrued_owed: u64,
    pub last_claimed_epoch: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct EpochState {
    pub epoch_index: u64,
    pub start_ts: i64,
    pub end_ts: i64,
    pub total_effective_mp: u128,
    pub daily_emission: u64,
    pub finalized: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct UserEpoch {
    pub owner: Pubkey,
    pub epoch_index: u64,
    pub user_mp: u128,
    pub claimed: bool,
    pub bump: u8,
}

#[event]
pub struct InitializeEvent {
    pub admin: Pubkey,
    pub xnt_mint: Pubkey,
    pub mind_mint: Pubkey,
    pub vault: Pubkey,
    pub epoch_seconds: u64,
    pub mind_decimals: u8,
    pub mined_cap: u64,
}

#[event]
pub struct PositionCreated {
    pub owner: Pubkey,
    pub duration_days: u16,
    pub time_multiplier_bps: u16,
}

#[event]
pub struct Deposited {
    pub owner: Pubkey,
    pub amount: u64,
    pub lock_end_ts: i64,
}

#[event]
pub struct HeartbeatEvent {
    pub owner: Pubkey,
    pub epoch_index: u64,
    pub user_mp: u128,
}

#[event]
pub struct Claimed {
    pub owner: Pubkey,
    pub epoch_index: u64,
    pub reward: u64,
    pub capped_user_mp: u128,
    pub total_epoch_mp: u128,
}

#[event]
pub struct Withdrawn {
    pub owner: Pubkey,
    pub amount: u64,
}

#[event]
pub struct ConfigUpdated {
    pub admin: Pubkey,
    pub th1: u64,
    pub th2: u64,
    pub mp_cap_bps_per_wallet: u16,
    pub epoch_seconds: u64,
}

fn time_multiplier_for_duration(duration_days: u16) -> Option<u16> {
    match duration_days {
        7 => Some(10_000),
        14 => Some(12_500),
        30 => Some(15_000),
        _ => None,
    }
}

fn compute_weighted_amount(amount: u64, th1: u64, th2: u64) -> u128 {
    let amt = amount as u128;
    let tier1 = amt.min(th1 as u128);
    let tier2 = amt.saturating_sub(th1 as u128).min(th2 as u128);
    let remainder = amt.saturating_sub((th1 as u128).saturating_add(th2 as u128));
    let weighted_tier2 = tier2
        .checked_mul(50)
        .and_then(|v| v.checked_div(100))
        .unwrap_or(0);
    let weighted_remainder = remainder
        .checked_mul(25)
        .and_then(|v| v.checked_div(100))
        .unwrap_or(0);
    tier1
        .checked_add(weighted_tier2)
        .and_then(|v| v.checked_add(weighted_remainder))
        .unwrap_or(0)
}

fn epoch_index_for_ts(config: &Config, ts: i64) -> Result<u64> {
    require!(ts >= config.emission_start_ts, ErrorCode::BeforeStart);
    let elapsed = ts
        .checked_sub(config.emission_start_ts)
        .ok_or(ErrorCode::MathOverflow)?;
    let epoch_seconds = config.epoch_seconds;
    require!(epoch_seconds > 0, ErrorCode::InvalidEpochLength);
    Ok((elapsed as u64) / epoch_seconds)
}

fn epoch_start_ts(config: &Config, epoch_index: u64) -> Result<i64> {
    let offset = (epoch_index)
        .checked_mul(config.epoch_seconds)
        .ok_or(ErrorCode::MathOverflow)?;
    let offset_i64 = i64::try_from(offset).map_err(|_| ErrorCode::MathOverflow)?;
    Ok(
        config
            .emission_start_ts
            .checked_add(offset_i64)
            .ok_or(ErrorCode::MathOverflow)?,
    )
}

fn emission_for_epoch(config: &Config, epoch_index: u64) -> Result<u64> {
    if config.mined_total >= config.mined_cap {
        return err!(ErrorCode::EmissionDepleted);
    }
    let elapsed_seconds = epoch_index
        .checked_mul(config.epoch_seconds)
        .ok_or(ErrorCode::MathOverflow)?;
    let halving_seconds = config
        .soft_halving_period_days
        .checked_mul(DEFAULT_EPOCH_SECONDS)
        .ok_or(ErrorCode::MathOverflow)?;
    let halving_count = if halving_seconds == 0 {
        0
    } else {
        elapsed_seconds / halving_seconds
    };

    let mut emission = config.daily_emission_initial as u128;
    for _ in 0..halving_count {
        emission = emission
            .checked_mul((BPS_DENOMINATOR as u64 - config.soft_halving_bps_drop as u64) as u128)
            .ok_or(ErrorCode::MathOverflow)?
            .checked_div(BPS_DENOMINATOR)
            .ok_or(ErrorCode::MathOverflow)?;
        if emission == 0 {
            break;
        }
    }

    let remaining = (config.mined_cap - config.mined_total) as u128;
    Ok(emission.min(remaining) as u64)
}

fn ten_pow(decimals: u8) -> Result<u64> {
    if decimals == 0 {
        return Ok(1);
    }
    Ok(
        10u64
            .checked_pow(decimals as u32)
            .ok_or(ErrorCode::MathOverflow)?,
    )
}

#[error_code]
pub enum ErrorCode {
    #[msg("Invalid mining duration")]
    InvalidDuration,
    #[msg("Invalid percentage value")]
    InvalidPercentage,
    #[msg("Invalid total supply")]
    InvalidSupply,
    #[msg("Mining cap must be positive")]
    InvalidCap,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Bump not found")]
    BumpNotFound,
    #[msg("Only owner can perform this action")]
    Unauthorized,
    #[msg("Position already active")]
    PositionActive,
    #[msg("Position is inactive")]
    InactivePosition,
    #[msg("Lock already expired")]
    LockExpired,
    #[msg("Lock not finished")]
    LockNotFinished,
    #[msg("Invalid amount")]
    InvalidAmount,
    #[msg("Epoch index mismatch")]
    InvalidEpochIndex,
    #[msg("Mining power is zero")]
    ZeroMiningPower,
    #[msg("Nothing left to emit")]
    EmissionDepleted,
    #[msg("Nothing to claim")]
    NothingToClaim,
    #[msg("Epoch already claimed")]
    AlreadyClaimed,
    #[msg("No mining power recorded for epoch")]
    NoEpochPower,
    #[msg("Emission not started yet")]
    BeforeStart,
    #[msg("Epoch length invalid")]
    InvalidEpochLength,
    #[msg("Epoch length edits are disabled")]
    EpochEditDisabled,
    #[msg("Provided decimals do not match the XNT mint")]
    DecimalsMismatch,
}
