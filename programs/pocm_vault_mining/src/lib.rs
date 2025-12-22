use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount, Transfer};
use solana_program::program_option::COption;

const STAKING_POSITION_SEED: &[u8] = b"stake";

declare_id!("2oJ68QPvNqvdegxPczqGYz7bmTyBSW9D6ZYs4w1HSpL9");

const CONFIG_SEED: &[u8] = b"config_v2";
const VAULT_SEED: &[u8] = b"vault";
const POSITION_SEED: &[u8] = b"position";
const PROFILE_SEED: &[u8] = b"profile";
const BPS_DENOMINATOR: u128 = 10_000;
const DEFAULT_EPOCH_SECONDS: u64 = 86_400;
const SECONDS_PER_DAY: i64 = 86_400;
const DEFAULT_SOFT_HALVING_DAYS: u64 = 90;
const DEFAULT_SOFT_HALVING_DROP_BPS: u16 = 1_000; // 10%
const DEFAULT_MP_CAP_BPS: u16 = 1_000; // 10%
const DAILY_EMISSION_TOKENS: u64 = 100_000;
const STAKING_REWARD_SCALE: u128 = 1_000_000_000_000_000_000; // 1e18

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
            config: *ctx.bumps.get("config").unwrap(),
            vault_authority: *ctx.bumps.get("vault_authority").unwrap(),
        };

        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.xnt_mint = params.xnt_mint;
        config.mind_mint = ctx.accounts.mind_mint.key();
        config.vault_xnt_ata = ctx.accounts.vault_xnt_ata.key();
        config.staking_vault_xnt_ata = ctx.accounts.staking_vault_xnt_ata.key();
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
        config.staking_vault_mind_ata = ctx.accounts.staking_vault_mind_ata.key();
        config.xp_per_7d = params.xp_per_7d;
        config.xp_per_14d = params.xp_per_14d;
        config.xp_per_30d = params.xp_per_30d;
        config.xp_tier_silver = params.xp_tier_silver;
        config.xp_tier_gold = params.xp_tier_gold;
        config.xp_tier_diamond = params.xp_tier_diamond;
        config.xp_boost_silver_bps = params.xp_boost_silver_bps;
        config.xp_boost_gold_bps = params.xp_boost_gold_bps;
        config.xp_boost_diamond_bps = params.xp_boost_diamond_bps;
        config.total_staked_mind = 0;
        config.total_xp = 0;
        config.mind_reward_7d = params.mind_reward_7d;
        config.mind_reward_14d = params.mind_reward_14d;
        config.mind_reward_28d = params.mind_reward_28d;
        config.staking_reward_per_weight = 0;
        config.staking_reward_pending = 0;
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

    pub fn create_position(
        ctx: Context<CreatePosition>,
        duration_days: u16,
        position_index: u64,
    ) -> Result<()> {
        let time_multiplier_bps =
            time_multiplier_for_duration(duration_days).ok_or(ErrorCode::InvalidDuration)?;

        if ctx.accounts.user_profile.owner == Pubkey::default() {
            ctx.accounts.user_profile.owner = ctx.accounts.owner.key();
            ctx.accounts.user_profile.next_position_index = 0;
            ctx.accounts.user_profile.next_stake_index = 0;
            ctx.accounts.user_profile.mining_xp = 0;
            ctx.accounts.user_profile.xp_tier = 0;
            ctx.accounts.user_profile.xp_boost_bps = 0;
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
        position.bump = *ctx.bumps.get("position").unwrap();

        ctx.accounts.user_profile.next_position_index = ctx
            .accounts
            .user_profile
            .next_position_index
            .checked_add(1)
            .ok_or(ErrorCode::MathOverflow)?;

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
        // Non-refundable mining fee model:
        // - each position can be funded once
        // - user may create multiple positions concurrently
        require!(position.locked_amount == 0, ErrorCode::PositionActive);
        require!(
            time_multiplier_for_duration(position.duration_days).is_some(),
            ErrorCode::InvalidDuration
        );
        let cfg = &mut ctx.accounts.config;
        let expected_fee = fee_for_duration(position.duration_days, cfg.xnt_decimals)?;
        require!(amount == expected_fee, ErrorCode::InvalidFeeAmount);
        let lock_day_seconds = if cfg.allow_epoch_seconds_edit {
            cfg.epoch_seconds as i64
        } else {
            SECONDS_PER_DAY
        };
        let now = Clock::get()?.unix_timestamp;
        let lock_duration = (position.duration_days as i64)
            .checked_mul(lock_day_seconds)
            .ok_or(ErrorCode::MathOverflow)?;

        let staking_share = amount.checked_div(4).ok_or(ErrorCode::MathOverflow)?;
        let treasury_share = amount
            .checked_sub(staking_share)
            .ok_or(ErrorCode::MathOverflow)?;

        if treasury_share > 0 {
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.owner_xnt_ata.to_account_info(),
                        to: ctx.accounts.vault_xnt_ata.to_account_info(),
                        authority: ctx.accounts.owner.to_account_info(),
                    },
                ),
                treasury_share,
            )?;
        }
        if staking_share > 0 {
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.owner_xnt_ata.to_account_info(),
                        to: ctx.accounts.staking_vault_xnt_ata.to_account_info(),
                        authority: ctx.accounts.owner.to_account_info(),
                    },
                ),
                staking_share,
            )?;
            accrue_staking_rewards(cfg, staking_share)?;
        }

        position.locked_amount = amount;
        position.lock_start_ts = now;
        position.lock_end_ts = now
            .checked_add(lock_duration)
            .ok_or(ErrorCode::MathOverflow)?;
        position.accrued_owed = 0;
        position.last_claimed_epoch = 0;

        let xp_gain = xp_for_duration(position.duration_days, cfg)?;
        apply_mining_xp(&mut ctx.accounts.user_profile, cfg, xp_gain)?;

        emit!(Deposited {
            owner: position.owner,
            amount,
            lock_end_ts: position.lock_end_ts,
        });
        Ok(())
    }

    pub fn create_stake(
        ctx: Context<CreateStake>,
        duration_days: u16,
        position_index: u64,
        amount: u64,
    ) -> Result<()> {
        require!(amount > 0, ErrorCode::InvalidAmount);
        let cfg = &mut ctx.accounts.config;
        require!(
            is_valid_staking_duration(duration_days),
            ErrorCode::InvalidStakingDuration
        );
        require!(
            position_index == ctx.accounts.user_profile.next_stake_index,
            ErrorCode::InvalidPositionIndex
        );
        let lock_day_seconds = if cfg.allow_epoch_seconds_edit {
            cfg.epoch_seconds as i64
        } else {
            SECONDS_PER_DAY
        };
        let now = Clock::get()?.unix_timestamp;
        let lock_duration = (duration_days as i64)
            .checked_mul(lock_day_seconds)
            .ok_or(ErrorCode::MathOverflow)?;

        let position = &mut ctx.accounts.staking_position;
        position.owner = ctx.accounts.owner.key();
        position.amount = amount;
        position.start_ts = now;
        position.lock_end_ts = now
            .checked_add(lock_duration)
            .ok_or(ErrorCode::MathOverflow)?;
        position.duration_days = duration_days;
        position.xp_boost_bps = ctx.accounts.user_profile.xp_boost_bps;
        position.last_claim_ts = now;
        position.stake_index = position_index;
        position.bump = *ctx.bumps.get("staking_position").unwrap();

        ctx.accounts.user_profile.next_stake_index = ctx
            .accounts
            .user_profile
            .next_stake_index
            .checked_add(1)
            .ok_or(ErrorCode::MathOverflow)?;

        let transfer_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.owner_mind_ata.to_account_info(),
                to: ctx.accounts.staking_vault_mind_ata.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        );
        token::transfer(transfer_ctx, amount)?;

        let weight = staking_weight(amount, duration_days, position.xp_boost_bps)?;
        let weight_u64 = u64::try_from(weight).map_err(|_| ErrorCode::MathOverflow)?;
        cfg.total_staked_mind = cfg
            .total_staked_mind
            .checked_add(weight_u64)
            .ok_or(ErrorCode::MathOverflow)?;
        position.reward_debt = weight
            .checked_mul(cfg.staking_reward_per_weight)
            .ok_or(ErrorCode::MathOverflow)?
            .checked_div(STAKING_REWARD_SCALE)
            .ok_or(ErrorCode::MathOverflow)?;
        apply_pending_staking_rewards(cfg)?;

        emit!(Staked {
            owner: ctx.accounts.owner.key(),
            amount,
            duration_days,
            xp_boost_bps: position.xp_boost_bps,
        });
        Ok(())
    }

    pub fn claim_stake_reward(
        ctx: Context<ClaimStakeReward>,
        _stake_index: u64,
        amount: u64,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let position = &mut ctx.accounts.staking_position;
        require!(amount > 0, ErrorCode::InvalidAmount);

        let cfg = &mut ctx.accounts.config;
        require!(cfg.total_staked_mind > 0, ErrorCode::NoStakedTokens);
        apply_pending_staking_rewards(cfg)?;
        let vault_balance = ctx.accounts.staking_vault_xnt_ata.amount as u128;
        require!(
            vault_balance >= amount as u128,
            ErrorCode::InsufficientVaultBalance
        );

        let weight = staking_weight(position.amount, position.duration_days, position.xp_boost_bps)?;
        let accrued = weight
            .checked_mul(cfg.staking_reward_per_weight)
            .ok_or(ErrorCode::MathOverflow)?
            .checked_div(STAKING_REWARD_SCALE)
            .ok_or(ErrorCode::MathOverflow)?;
        let claimable = accrued.saturating_sub(position.reward_debt);
        require!(claimable > 0, ErrorCode::NoStakingRewards);
        require!(
            (amount as u128) <= claimable,
            ErrorCode::ClaimAmountTooLarge
        );

        let signer_seeds: &[&[u8]] = &[VAULT_SEED, &[cfg.bumps.vault_authority]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.staking_vault_xnt_ata.to_account_info(),
                    to: ctx.accounts.owner_xnt_ata.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                &[signer_seeds],
            ),
            amount,
        )?;

        position.reward_debt = position
            .reward_debt
            .checked_add(amount as u128)
            .ok_or(ErrorCode::MathOverflow)?;
        position.last_claim_ts = now;

        emit!(StakeRewardClaimed {
            owner: ctx.accounts.owner.key(),
            amount,
            xp_boost_bps: position.xp_boost_bps,
        });
        Ok(())
    }

    pub fn withdraw_stake(ctx: Context<WithdrawStake>, _stake_index: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let position = &ctx.accounts.staking_position;
        require!(now >= position.lock_end_ts, ErrorCode::LockNotFinished);

        let cfg = &mut ctx.accounts.config;
        let weight = staking_weight(position.amount, position.duration_days, position.xp_boost_bps)?;
        let weight_u64 = u64::try_from(weight).map_err(|_| ErrorCode::MathOverflow)?;
        cfg.total_staked_mind = cfg
            .total_staked_mind
            .checked_sub(weight_u64)
            .ok_or(ErrorCode::MathOverflow)?;

        let withdrawn_amount = position.amount;
        let signer_seeds: &[&[u8]] = &[VAULT_SEED, &[cfg.bumps.vault_authority]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.staking_vault_mind_ata.to_account_info(),
                    to: ctx.accounts.owner_mind_ata.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                &[signer_seeds],
            ),
            withdrawn_amount,
        )?;

        let position = ctx.accounts.staking_position.as_mut();
        position.amount = 0;
        position.reward_debt = 0;
        position.last_claim_ts = now;

        emit!(StakeWithdrawn {
            owner: ctx.accounts.owner.key(),
            amount: withdrawn_amount,
        });
        Ok(())
    }

    pub fn claim(ctx: Context<Claim>, amount: u64) -> Result<()> {
        let config = &mut ctx.accounts.config;
        let now = Clock::get()?.unix_timestamp;
        require!(amount > 0, ErrorCode::InvalidAmount);
        let mut total_claimable: u128 = 0;

        for acc_info in ctx.remaining_accounts.iter() {
            if acc_info.owner != &crate::ID || !acc_info.is_writable {
                continue;
            }
            let mut position: Account<UserPosition> = Account::try_from(acc_info)?;
            if position.owner != ctx.accounts.owner.key() {
                continue;
            }
            if position.locked_amount == 0 {
                continue;
            }
            if now <= position.lock_start_ts {
                continue;
            }
            let total_reward_for_position = reward_for_duration(position.duration_days, config)?;
            let duration_seconds = position
                .lock_end_ts
                .checked_sub(position.lock_start_ts)
                .ok_or(ErrorCode::MathOverflow)?;
            let elapsed_seconds = now
                .min(position.lock_end_ts)
                .checked_sub(position.lock_start_ts)
                .ok_or(ErrorCode::MathOverflow)?
                .max(0);
            if duration_seconds <= 0 || elapsed_seconds <= 0 {
                continue;
            }
            let accrued = total_reward_for_position
                .checked_mul(elapsed_seconds as u128)
                .ok_or(ErrorCode::MathOverflow)?
                .checked_div(duration_seconds as u128)
                .ok_or(ErrorCode::MathOverflow)?;
            let claimed = position.accrued_owed as u128;
            let claimable = accrued.saturating_sub(claimed);
            if claimable == 0 {
                continue;
            }
            total_claimable = total_claimable
                .checked_add(claimable)
                .ok_or(ErrorCode::MathOverflow)?;
        }

        let remaining = config
            .mined_cap
            .checked_sub(config.mined_total)
            .ok_or(ErrorCode::EmissionDepleted)? as u128;
        let max_claimable = total_claimable.min(remaining);
        require!(max_claimable > 0, ErrorCode::NothingToClaim);
        require!(
            (amount as u128) <= max_claimable,
            ErrorCode::ClaimAmountTooLarge
        );
        let reward_u64 = amount;

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

        config.mined_total = config
            .mined_total
            .checked_add(reward_u64)
            .ok_or(ErrorCode::MathOverflow)?;

        let mut remaining_amount = reward_u64 as u128;
        for acc_info in ctx.remaining_accounts.iter() {
            if remaining_amount == 0 {
                break;
            }
            if acc_info.owner != &crate::ID || !acc_info.is_writable {
                continue;
            }
            let mut position: Account<UserPosition> = Account::try_from(acc_info)?;
            if position.owner != ctx.accounts.owner.key() {
                continue;
            }
            if position.locked_amount == 0 || now <= position.lock_start_ts {
                continue;
            }
            let total_reward_for_position = reward_for_duration(position.duration_days, config)?;
            let duration_seconds = position
                .lock_end_ts
                .checked_sub(position.lock_start_ts)
                .ok_or(ErrorCode::MathOverflow)?;
            let elapsed_seconds = now
                .min(position.lock_end_ts)
                .checked_sub(position.lock_start_ts)
                .ok_or(ErrorCode::MathOverflow)?
                .max(0);
            if duration_seconds <= 0 || elapsed_seconds <= 0 {
                continue;
            }
            let accrued = total_reward_for_position
                .checked_mul(elapsed_seconds as u128)
                .ok_or(ErrorCode::MathOverflow)?
                .checked_div(duration_seconds as u128)
                .ok_or(ErrorCode::MathOverflow)?;
            let claimed = position.accrued_owed as u128;
            let claimable = accrued.saturating_sub(claimed);
            if claimable == 0 {
                continue;
            }
            let take = remaining_amount.min(claimable);
            position.accrued_owed = position
                .accrued_owed
                .checked_add(u64::try_from(take).map_err(|_| ErrorCode::MathOverflow)?)
                .ok_or(ErrorCode::MathOverflow)?;
            remaining_amount = remaining_amount.saturating_sub(take);
            position.exit(ctx.program_id)?;
        }

        emit!(Claimed {
            owner: ctx.accounts.owner.key(),
            reward: reward_u64,
            positions_claimed: ctx.remaining_accounts.len() as u64,
        });
        Ok(())
    }

    pub fn withdraw(ctx: Context<Withdraw>) -> Result<()> {
        let position = &ctx.accounts.position;
        require_keys_eq!(
            position.owner,
            ctx.accounts.owner.key(),
            ErrorCode::Unauthorized
        );
        require!(position.locked_amount > 0, ErrorCode::InactivePosition);
        let now = Clock::get()?.unix_timestamp;
        require!(now >= position.lock_end_ts, ErrorCode::LockNotFinished);

        // Custodial mining: no XNT is returned; this only closes the position account (rent reclaim).
        emit!(Withdrawn {
            owner: position.owner,
            amount: position.locked_amount,
        });
        Ok(())
    }

    pub fn admin_withdraw_treasury_xnt(
        ctx: Context<AdminWithdrawTreasuryXnt>,
        amount: u64,
    ) -> Result<()> {
        require!(amount > 0, ErrorCode::InvalidAmount);
        let seeds: &[&[u8]] = &[VAULT_SEED, &[ctx.accounts.config.bumps.vault_authority]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault_xnt_ata.to_account_info(),
                    to: ctx.accounts.admin_xnt_ata.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )?;
        Ok(())
    }

    pub fn admin_fund_staking_xnt(ctx: Context<AdminFundStakingXnt>, amount: u64) -> Result<()> {
        require!(amount > 0, ErrorCode::InvalidAmount);
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.admin_xnt_ata.to_account_info(),
                    to: ctx.accounts.staking_vault_xnt_ata.to_account_info(),
                    authority: ctx.accounts.admin.to_account_info(),
                },
            ),
            amount,
        )?;
        let cfg = &mut ctx.accounts.config;
        accrue_staking_rewards(cfg, amount)?;
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
        if params.update_xp_config {
            config.xp_per_7d = params.xp_per_7d;
            config.xp_per_14d = params.xp_per_14d;
            config.xp_per_30d = params.xp_per_30d;
            config.xp_tier_silver = params.xp_tier_silver;
            config.xp_tier_gold = params.xp_tier_gold;
            config.xp_tier_diamond = params.xp_tier_diamond;
            config.xp_boost_silver_bps = params.xp_boost_silver_bps;
            config.xp_boost_gold_bps = params.xp_boost_gold_bps;
            config.xp_boost_diamond_bps = params.xp_boost_diamond_bps;
        }
        if params.update_mind_rewards {
            config.mind_reward_7d = params.mind_reward_7d;
            config.mind_reward_14d = params.mind_reward_14d;
            config.mind_reward_28d = params.mind_reward_28d;
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

    pub fn admin_update_staking_vault(
        ctx: Context<AdminUpdateStakingVault>,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.staking_vault_xnt_ata = ctx.accounts.staking_vault_xnt_ata.key();
        Ok(())
    }

    pub fn admin_set_staking_weighted_total(
        ctx: Context<AdminSetStakingWeightedTotal>,
        total_weighted: u64,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.total_staked_mind = total_weighted;
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(params: InitializeParams)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub admin: Signer<'info>,
    /// CHECK: PDA derived from VAULT_SEED/bump used as the vault authority
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
    #[account(
        constraint = staking_vault_xnt_ata.owner == vault_authority.key(),
        constraint = staking_vault_xnt_ata.mint == xnt_mint.key()
    )]
    pub staking_vault_xnt_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    #[account(
        constraint = staking_vault_mind_ata.owner == vault_authority.key(),
        constraint = staking_vault_mind_ata.mint == mind_mint.key()
    )]
    pub staking_vault_mind_ata: Account<'info, TokenAccount>,
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
    pub xp_per_7d: u64,
    pub xp_per_14d: u64,
    pub xp_per_30d: u64,
    pub xp_tier_silver: u64,
    pub xp_tier_gold: u64,
    pub xp_tier_diamond: u64,
    pub xp_boost_silver_bps: u16,
    pub xp_boost_gold_bps: u16,
    pub xp_boost_diamond_bps: u16,
    pub mind_reward_7d: u64,
    pub mind_reward_14d: u64,
    pub mind_reward_28d: u64,
}

#[derive(Accounts)]
#[instruction(duration_days: u16, position_index: u64)]
pub struct CreatePosition<'info> {
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
        space = 8 + UserProfile::INIT_SPACE,
        seeds = [PROFILE_SEED, owner.key().as_ref()],
        bump
    )]
    pub user_profile: Box<Account<'info, UserProfile>>,
    #[account(
        init,
        payer = owner,
        space = 8 + UserPosition::INIT_SPACE,
        seeds = [POSITION_SEED, owner.key().as_ref(), position_index.to_le_bytes().as_ref()],
        bump
    )]
    pub position: Box<Account<'info, UserPosition>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    pub owner: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bumps.config
    )]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut,
        seeds = [PROFILE_SEED, owner.key().as_ref()],
        bump = user_profile.bump,
        constraint = user_profile.owner == owner.key()
    )]
    pub user_profile: Box<Account<'info, UserProfile>>,
    #[account(
        mut,
        constraint = position.owner == owner.key()
    )]
    pub position: Box<Account<'info, UserPosition>>,
    #[account(seeds = [VAULT_SEED], bump = config.bumps.vault_authority)]
    /// CHECK: PDA derived from VAULT_SEED/bump used as the vault authority
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
        constraint = staking_vault_xnt_ata.key() == config.staking_vault_xnt_ata,
        constraint = staking_vault_xnt_ata.owner == vault_authority.key(),
        constraint = staking_vault_xnt_ata.mint == xnt_mint.key()
    )]
    pub staking_vault_xnt_ata: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = owner_xnt_ata.owner == owner.key(),
        constraint = owner_xnt_ata.mint == xnt_mint.key()
    )]
    pub owner_xnt_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(duration_days: u16, position_index: u64, amount: u64)]
pub struct CreateStake<'info> {
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
        bump = user_profile.bump,
        constraint = user_profile.owner == owner.key()
    )]
    pub user_profile: Box<Account<'info, UserProfile>>,
    #[account(
        init,
        payer = owner,
        space = 8 + StakingPosition::INIT_SPACE,
        seeds = [STAKING_POSITION_SEED, owner.key().as_ref(), position_index.to_le_bytes().as_ref()],
        bump
    )]
    pub staking_position: Box<Account<'info, StakingPosition>>,
    #[account(
        seeds = [VAULT_SEED],
        bump = config.bumps.vault_authority
    )]
    /// CHECK: PDA derived from VAULT_SEED/bump used as the vault authority
    pub vault_authority: UncheckedAccount<'info>,
    #[account(
        mut,
        constraint = staking_vault_mind_ata.key() == config.staking_vault_mind_ata,
        constraint = staking_vault_mind_ata.owner == vault_authority.key(),
        constraint = staking_vault_mind_ata.mint == config.mind_mint
    )]
    pub staking_vault_mind_ata: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = owner_mind_ata.owner == owner.key(),
        constraint = owner_mind_ata.mint == config.mind_mint
    )]
    pub owner_mind_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
#[instruction(stake_index: u64)]
pub struct ClaimStakeReward<'info> {
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
        seeds = [STAKING_POSITION_SEED, owner.key().as_ref(), stake_index.to_le_bytes().as_ref()],
        bump = staking_position.bump,
        constraint = staking_position.owner == owner.key()
    )]
    pub staking_position: Box<Account<'info, StakingPosition>>,
    #[account(
        seeds = [VAULT_SEED],
        bump = config.bumps.vault_authority
    )]
    /// CHECK: PDA derived from VAULT_SEED/bump used as the vault authority
    pub vault_authority: UncheckedAccount<'info>,
    #[account(
        mut,
        constraint = staking_vault_xnt_ata.key() == config.staking_vault_xnt_ata,
        constraint = staking_vault_xnt_ata.owner == vault_authority.key(),
        constraint = staking_vault_xnt_ata.mint == config.xnt_mint
    )]
    pub staking_vault_xnt_ata: Account<'info, TokenAccount>,
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
pub struct WithdrawStake<'info> {
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
        close = owner,
        constraint = staking_position.owner == owner.key()
    )]
    pub staking_position: Box<Account<'info, StakingPosition>>,
    #[account(
        seeds = [VAULT_SEED],
        bump = config.bumps.vault_authority
    )]
    /// CHECK: PDA derived from VAULT_SEED/bump used as the vault authority
    pub vault_authority: UncheckedAccount<'info>,
    #[account(
        mut,
        constraint = staking_vault_mind_ata.key() == config.staking_vault_mind_ata,
        constraint = staking_vault_mind_ata.owner == vault_authority.key(),
        constraint = staking_vault_mind_ata.mint == config.mind_mint
    )]
    pub staking_vault_mind_ata: Account<'info, TokenAccount>,
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
pub struct Claim<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bumps.config
    )]
    pub config: Box<Account<'info, Config>>,
    #[account(
        seeds = [VAULT_SEED],
        bump = config.bumps.vault_authority
    )]
    /// CHECK: PDA derived from VAULT_SEED/bump used as the vault authority
    pub vault_authority: UncheckedAccount<'info>,
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
        mut,
        close = owner,
        constraint = position.owner == owner.key()
    )]
    pub position: Box<Account<'info, UserPosition>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminWithdrawTreasuryXnt<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bumps.config,
        has_one = admin
    )]
    pub config: Box<Account<'info, Config>>,
    #[account(
        seeds = [VAULT_SEED],
        bump = config.bumps.vault_authority
    )]
    /// CHECK: PDA derived from VAULT_SEED/bump used as the vault authority
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
        payer = admin,
        associated_token::mint = xnt_mint,
        associated_token::authority = admin
    )]
    pub admin_xnt_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminFundStakingXnt<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bumps.config,
        has_one = admin
    )]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut,
        constraint = xnt_mint.key() == config.xnt_mint
    )]
    pub xnt_mint: Account<'info, Mint>,
    #[account(
        mut,
        constraint = staking_vault_xnt_ata.key() == config.staking_vault_xnt_ata,
        constraint = staking_vault_xnt_ata.owner == vault_authority.key(),
        constraint = staking_vault_xnt_ata.mint == xnt_mint.key()
    )]
    pub staking_vault_xnt_ata: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = admin_xnt_ata.owner == admin.key(),
        constraint = admin_xnt_ata.mint == xnt_mint.key()
    )]
    pub admin_xnt_ata: Account<'info, TokenAccount>,
    #[account(
        seeds = [VAULT_SEED],
        bump = config.bumps.vault_authority
    )]
    /// CHECK: PDA derived from VAULT_SEED/bump used as the vault authority
    pub vault_authority: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminUpdateConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bumps.config,
        has_one = admin,
        realloc = 8 + Config::INIT_SPACE,
        realloc::payer = admin,
        realloc::zero = false
    )]
    pub config: Box<Account<'info, Config>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminUpdateStakingVault<'info> {
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bumps.config,
        has_one = admin
    )]
    pub config: Box<Account<'info, Config>>,
    #[account(
        seeds = [VAULT_SEED],
        bump = config.bumps.vault_authority
    )]
    /// CHECK: PDA derived from VAULT_SEED/bump used as the vault authority
    pub vault_authority: UncheckedAccount<'info>,
    #[account(
        constraint = staking_vault_xnt_ata.owner == vault_authority.key(),
        constraint = staking_vault_xnt_ata.mint == config.xnt_mint
    )]
    pub staking_vault_xnt_ata: Account<'info, TokenAccount>,
}

#[derive(Accounts)]
pub struct AdminSetStakingWeightedTotal<'info> {
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
    pub update_xp_config: bool,
    pub xp_per_7d: u64,
    pub xp_per_14d: u64,
    pub xp_per_30d: u64,
    pub xp_tier_silver: u64,
    pub xp_tier_gold: u64,
    pub xp_tier_diamond: u64,
    pub xp_boost_silver_bps: u16,
    pub xp_boost_gold_bps: u16,
    pub xp_boost_diamond_bps: u16,
    pub update_mind_rewards: bool,
    pub mind_reward_7d: u64,
    pub mind_reward_14d: u64,
    pub mind_reward_28d: u64,
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub xnt_mint: Pubkey,
    pub mind_mint: Pubkey,
    pub vault_xnt_ata: Pubkey,
    pub staking_vault_xnt_ata: Pubkey,
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
    pub staking_vault_mind_ata: Pubkey,
    pub xp_per_7d: u64,
    pub xp_per_14d: u64,
    pub xp_per_30d: u64,
    pub xp_tier_silver: u64,
    pub xp_tier_gold: u64,
    pub xp_tier_diamond: u64,
    pub xp_boost_silver_bps: u16,
    pub xp_boost_gold_bps: u16,
    pub xp_boost_diamond_bps: u16,
    pub total_staked_mind: u64,
    pub staking_reward_per_weight: u128,
    pub staking_reward_pending: u128,
    pub total_xp: u128,
    pub mind_reward_7d: u64,
    pub mind_reward_14d: u64,
    pub mind_reward_28d: u64,
    pub bumps: ConfigBumps,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
pub struct ConfigBumps {
    pub config: u8,
    pub vault_authority: u8,
}

#[account]
#[derive(InitSpace)]
pub struct UserProfile {
    pub owner: Pubkey,
    pub next_position_index: u64,
    pub next_stake_index: u64,
    pub mining_xp: u64,
    pub xp_tier: u8,
    pub xp_boost_bps: u16,
    pub bump: u8,
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
pub struct StakingPosition {
    pub owner: Pubkey,
    pub amount: u64,
    pub start_ts: i64,
    pub lock_end_ts: i64,
    pub duration_days: u16,
    pub xp_boost_bps: u16,
    pub reward_debt: u128,
    pub last_claim_ts: i64,
    pub stake_index: u64,
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
pub struct Claimed {
    pub owner: Pubkey,
    pub reward: u64,
    pub positions_claimed: u64,
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

#[event]
pub struct Staked {
    pub owner: Pubkey,
    pub amount: u64,
    pub duration_days: u16,
    pub xp_boost_bps: u16,
}

#[event]
pub struct StakeRewardClaimed {
    pub owner: Pubkey,
    pub amount: u64,
    pub xp_boost_bps: u16,
}

#[event]
pub struct StakeWithdrawn {
    pub owner: Pubkey,
    pub amount: u64,
}

fn time_multiplier_for_duration(duration_days: u16) -> Option<u16> {
    match duration_days {
        7 => Some(10_000),
        14 => Some(12_000),
        28 | 30 => Some(14_000),
        _ => None,
    }
}

fn compute_weighted_amount(amount: u64, th1: u64, th2: u64) -> u128 {
    let _ = (th1, th2);
    amount as u128
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

fn ten_pow(decimals: u8) -> Result<u64> {
    if decimals == 0 {
        return Ok(1);
    }
    Ok(10u64
        .checked_pow(decimals as u32)
        .ok_or(ErrorCode::MathOverflow)?)
}

fn fee_for_duration(duration_days: u16, xnt_decimals: u8) -> Result<u64> {
    let base = ten_pow(xnt_decimals)?;
    match duration_days {
        7 => {
            require!(xnt_decimals > 0, ErrorCode::InvalidAmount);
            Ok(base / 10) // 0.1 XNT
        }
        14 => Ok(base), // 1 XNT
        28 | 30 => base
            .checked_mul(5)
            .ok_or_else(|| ErrorCode::MathOverflow.into()), // 5 XNT
        _ => err!(ErrorCode::InvalidDuration),
    }
}

fn xp_for_duration(duration_days: u16, cfg: &Config) -> Result<u64> {
    match duration_days {
        7 => Ok(cfg.xp_per_7d),
        14 => Ok(cfg.xp_per_14d),
        28 | 30 => Ok(cfg.xp_per_30d),
        _ => err!(ErrorCode::InvalidDuration),
    }
}

fn reward_for_duration(duration_days: u16, cfg: &Config) -> Result<u128> {
    let reward = match duration_days {
        7 => cfg.mind_reward_7d,
        14 => cfg.mind_reward_14d,
        28 | 30 => cfg.mind_reward_28d,
        _ => return err!(ErrorCode::InvalidDuration),
    };
    require!(reward > 0, ErrorCode::InvalidAmount);
    Ok(reward as u128)
}

fn tier_from_xp(xp: u64, cfg: &Config) -> (u8, u16) {
    if xp >= cfg.xp_tier_diamond {
        return (3, cfg.xp_boost_diamond_bps);
    }
    if xp >= cfg.xp_tier_gold {
        return (2, cfg.xp_boost_gold_bps);
    }
    if xp >= cfg.xp_tier_silver {
        return (1, cfg.xp_boost_silver_bps);
    }
    (0, 0)
}

fn apply_mining_xp(
    profile: &mut Account<UserProfile>,
    cfg: &mut Account<Config>,
    xp_gain: u64,
) -> Result<()> {
    profile.mining_xp = profile
        .mining_xp
        .checked_add(xp_gain)
        .ok_or(ErrorCode::MathOverflow)?;
    let (tier, boost) = tier_from_xp(profile.mining_xp, cfg);
    profile.xp_tier = tier;
    profile.xp_boost_bps = boost;
    cfg.total_xp = cfg
        .total_xp
        .checked_add(xp_gain as u128)
        .ok_or(ErrorCode::MathOverflow)?;
    Ok(())
}

fn is_valid_staking_duration(duration: u16) -> bool {
    matches!(duration, 7 | 14 | 30 | 60)
}

fn staking_duration_multiplier_bps(duration: u16) -> Result<u16> {
    match duration {
        7 => Ok(10_000),
        14 => Ok(11_000),
        30 => Ok(12_500),
        60 => Ok(15_000),
        _ => Err(error!(ErrorCode::InvalidStakingDuration)),
    }
}

fn staking_weight(amount: u64, duration: u16, xp_boost_bps: u16) -> Result<u128> {
    let duration_mult = staking_duration_multiplier_bps(duration)? as u128;
    let base = (amount as u128)
        .checked_mul(duration_mult)
        .ok_or(ErrorCode::MathOverflow)?
        .checked_div(BPS_DENOMINATOR)
        .ok_or(ErrorCode::MathOverflow)?;
    let boost = 10_000u128
        .checked_add(xp_boost_bps as u128)
        .ok_or(ErrorCode::MathOverflow)?;
    base.checked_mul(boost)
        .ok_or(ErrorCode::MathOverflow)?
        .checked_div(BPS_DENOMINATOR)
        .ok_or(ErrorCode::MathOverflow.into())
}

fn accrue_staking_rewards(cfg: &mut Account<Config>, amount: u64) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    if cfg.total_staked_mind == 0 {
        cfg.staking_reward_pending = cfg
            .staking_reward_pending
            .checked_add(amount as u128)
            .ok_or(ErrorCode::MathOverflow)?;
        return Ok(());
    }
    let delta = (amount as u128)
        .checked_mul(STAKING_REWARD_SCALE)
        .ok_or(ErrorCode::MathOverflow)?
        .checked_div(cfg.total_staked_mind as u128)
        .ok_or(ErrorCode::MathOverflow)?;
    cfg.staking_reward_per_weight = cfg
        .staking_reward_per_weight
        .checked_add(delta)
        .ok_or(ErrorCode::MathOverflow)?;
    Ok(())
}

fn apply_pending_staking_rewards(cfg: &mut Account<Config>) -> Result<()> {
    if cfg.total_staked_mind == 0 || cfg.staking_reward_pending == 0 {
        return Ok(());
    }
    let delta = cfg
        .staking_reward_pending
        .checked_mul(STAKING_REWARD_SCALE)
        .ok_or(ErrorCode::MathOverflow)?
        .checked_div(cfg.total_staked_mind as u128)
        .ok_or(ErrorCode::MathOverflow)?;
    cfg.staking_reward_per_weight = cfg
        .staking_reward_per_weight
        .checked_add(delta)
        .ok_or(ErrorCode::MathOverflow)?;
    cfg.staking_reward_pending = 0;
    Ok(())
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
    #[msg("Invalid position index")]
    InvalidPositionIndex,
    #[msg("Invalid fee amount for selected duration")]
    InvalidFeeAmount,
    #[msg("Invalid staking duration")]
    InvalidStakingDuration,
    #[msg("Claim too early")]
    TooEarlyClaim,
    #[msg("No staking rewards available")]
    NoStakingRewards,
    #[msg("No staked tokens")]
    NoStakedTokens,
    #[msg("Claim amount exceeds available rewards")]
    ClaimAmountTooLarge,
    #[msg("Staking vault balance too low")]
    InsufficientVaultBalance,
}
