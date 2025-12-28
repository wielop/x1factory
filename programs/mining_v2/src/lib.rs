use anchor_lang::prelude::*;
use anchor_lang::Discriminator;
use anchor_lang::system_program::{self, Transfer as SystemTransfer};
use anchor_spl::token::{self, Burn, Mint, MintTo, Token, TokenAccount, Transfer};
use solana_program::program_option::COption;

declare_id!("uaDkkJGLLEY3kFMhhvrh5MZJ6fmwCmhNf8L7BZQJ9Aw");

const CONFIG_SEED: &[u8] = b"config";
const VAULT_SEED: &[u8] = b"vault";
const STAKING_REWARD_VAULT_SEED: &[u8] = b"staking_reward_vault";
const TREASURY_VAULT_SEED: &[u8] = b"treasury_vault";
const POSITION_SEED: &[u8] = b"position";
const PROFILE_SEED: &[u8] = b"profile";
const STAKE_SEED: &[u8] = b"stake";
const LEVEL_CONFIG_SEED: &[u8] = b"level_config";
const HP_SCALE_SEED: &[u8] = b"hp_scale";
const RIG_BUFF_CONFIG_SEED: &[u8] = b"rig_buff";

const BPS_DENOMINATOR: u128 = 10_000;
const ACC_SCALE: u128 = 1_000_000_000_000_000_000;
const HP_SCALE: u128 = 100;
const HP_SCALE_U64: u64 = 100;
const HP_SCALED_MARKER: u64 = 1 << 63;
const SECONDS_PER_DAY_DEFAULT: u64 = 86_400;
const STAKING_SHARE_BPS: u128 = 3_000; // 30%
const BADGE_BONUS_CAP_BPS: u16 = 2_000; // 20%
const LEVEL_BONUS_CAP_BPS: u16 = 1_000; // 10%
const UNSTAKE_BURN_BPS: u128 = 300; // 3%
const XNT_BASE: u64 = 1_000_000_000;
const MIND_DECIMALS: u64 = 1_000_000_000;
const XP_SECONDS_PER_POINT_DENOMINATOR: u64 = 36_000;
const RIG_BUFF_CAP_BPS: u16 = 850; // 8.5%
const RIG_BUFF_COST_BPS: u128 = 150; // 1.5%

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
            ctx.accounts.mind_mint.mint_authority
                == COption::Some(ctx.accounts.vault_authority.key()),
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
        config.xnt_mint = System::id();
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

        ctx.accounts.staking_reward_vault.bump = *ctx.bumps.get("staking_reward_vault").unwrap();
        ctx.accounts.treasury_vault.bump = *ctx.bumps.get("treasury_vault").unwrap();

        emit!(ConfigInitialized {
            admin: config.admin,
            emission_per_sec: config.emission_per_sec,
            max_effective_hp: config.max_effective_hp,
        });
        Ok(())
    }

    pub fn init_level_config(ctx: Context<InitLevelConfig>) -> Result<()> {
        let cfg = &ctx.accounts.config;
        require_keys_eq!(cfg.admin, ctx.accounts.admin.key(), ErrorCode::Unauthorized);
        require_keys_eq!(
            cfg.mind_mint,
            ctx.accounts.mind_mint.key(),
            ErrorCode::InvalidMint
        );

        let level_cfg = &mut ctx.accounts.level_config;
        level_cfg.admin = cfg.admin;
        level_cfg.mind_mint = cfg.mind_mint;
        level_cfg.mind_burn_vault = ctx.accounts.mind_burn_vault.key();
        level_cfg.mind_treasury_vault = ctx.accounts.mind_treasury_vault.key();
        level_cfg.bump = *ctx.bumps.get("level_config").unwrap();
        Ok(())
    }

    pub fn init_rig_buff_config(
        ctx: Context<InitRigBuffConfig>,
        params: InitRigBuffConfigParams,
    ) -> Result<()> {
        require!(params.mind_per_hp_per_day > 0, ErrorCode::InvalidAmount);
        let cfg = &ctx.accounts.config;
        require_keys_eq!(cfg.admin, ctx.accounts.admin.key(), ErrorCode::Unauthorized);
        require_keys_eq!(
            cfg.mind_mint,
            ctx.accounts.mind_mint.key(),
            ErrorCode::InvalidMint
        );
        require!(
            ctx.accounts.mind_burn_vault.mint == ctx.accounts.mind_mint.key(),
            ErrorCode::InvalidMint
        );
        require!(
            ctx.accounts.mind_treasury_vault.mint == ctx.accounts.mind_mint.key(),
            ErrorCode::InvalidMint
        );

        let buff = &mut ctx.accounts.rig_buff_config;
        buff.admin = cfg.admin;
        buff.mind_mint = cfg.mind_mint;
        buff.mind_burn_vault = ctx.accounts.mind_burn_vault.key();
        buff.mind_treasury_vault = ctx.accounts.mind_treasury_vault.key();
        buff.mind_per_hp_per_day = params.mind_per_hp_per_day;
        buff.bump = *ctx.bumps.get("rig_buff_config").unwrap();
        Ok(())
    }

    pub fn admin_update_rig_buff_config(
        ctx: Context<AdminUpdateRigBuffConfig>,
        params: UpdateRigBuffConfigParams,
    ) -> Result<()> {
        require!(params.mind_per_hp_per_day > 0, ErrorCode::InvalidAmount);
        require_keys_eq!(
            ctx.accounts.rig_buff_config.admin,
            ctx.accounts.admin.key(),
            ErrorCode::Unauthorized
        );
        ctx.accounts.rig_buff_config.mind_per_hp_per_day = params.mind_per_hp_per_day;
        Ok(())
    }

    pub fn buy_contract(
        ctx: Context<BuyContract>,
        contract_type: u8,
        position_index: u64,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let cfg = &mut ctx.accounts.config;
        update_mining_global(cfg, now)?;

        let bump = *ctx.bumps.get("user_profile").unwrap();
        let mut profile = ensure_user_profile_v2(
            &ctx.accounts.user_profile,
            &ctx.accounts.owner.to_account_info(),
            &ctx.accounts.system_program,
            ctx.accounts.owner.key(),
            bump,
            now,
        )?;
        require_keys_eq!(
            profile.owner,
            ctx.accounts.owner.key(),
            ErrorCode::Unauthorized
        );
        update_user_xp(&mut profile, now)?;
        require!(
            position_index == profile.next_position_index,
            ErrorCode::InvalidPositionIndex
        );

        let (duration_days, base_hp_scaled, cost_base) = contract_terms(contract_type)?;
        let seconds_per_day = cfg.seconds_per_day;
        let duration_seconds = (duration_days as i64)
            .checked_mul(seconds_per_day as i64)
            .ok_or(ErrorCode::MathOverflow)?;

        let new_active_hp = profile
            .active_hp
            .checked_add(base_hp_scaled)
            .ok_or(ErrorCode::MathOverflow)?;
        require!(
            new_active_hp <= cfg
                .max_effective_hp
                .checked_mul(HP_SCALE_U64)
                .ok_or(ErrorCode::MathOverflow)?,
            ErrorCode::MaxEffectiveHpExceeded
        );

        let hp_effective = effective_hp_scaled(
            base_hp_scaled as u128,
            profile.level,
            0,
        )?;
        let reward_debt = earned_per_hp(hp_effective, cfg.acc_mind_per_hp)?;
        let position = &mut ctx.accounts.position;
        position.owner = ctx.accounts.owner.key();
        position.hp = base_hp_scaled;
        position.start_ts = now;
        position.end_ts = now
            .checked_add(duration_seconds)
            .ok_or(ErrorCode::MathOverflow)?;
        position.reward_debt = reward_debt;
        position.final_acc_mind_per_hp = 0;
        position.deactivated = false;
        position.bump = *ctx.bumps.get("position").unwrap();
        position.rig_type = contract_type;
        position.buff_level = 0;
        position.hp_scaled = true;
        position.expired = false;
        position.buff_applied_from_cycle = 0;

        profile.active_hp = new_active_hp;
        let hp_effective_u64 = u64::try_from(hp_effective).map_err(|_| ErrorCode::MathOverflow)?;
        cfg.network_hp_active = cfg
            .network_hp_active
            .checked_add(hp_effective_u64)
            .ok_or(ErrorCode::MathOverflow)?;

        let staking_share = (cost_base as u128)
            .checked_mul(STAKING_SHARE_BPS)
            .ok_or(ErrorCode::MathOverflow)?
            .checked_div(BPS_DENOMINATOR)
            .ok_or(ErrorCode::MathOverflow)? as u64;
        let treasury_share = cost_base
            .checked_sub(staking_share)
            .ok_or(ErrorCode::MathOverflow)?;

        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                SystemTransfer {
                    from: ctx.accounts.owner.to_account_info(),
                    to: ctx.accounts.treasury_vault.to_account_info(),
                },
            ),
            treasury_share,
        )?;
        if staking_share > 0 {
            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    SystemTransfer {
                        from: ctx.accounts.owner.to_account_info(),
                        to: ctx.accounts.staking_reward_vault.to_account_info(),
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

        profile.next_position_index = profile
            .next_position_index
            .checked_add(1)
            .ok_or(ErrorCode::MathOverflow)?;

        save_user_profile(&ctx.accounts.user_profile, &profile)?;

        emit!(ContractPurchased {
            owner: position.owner,
            hp: base_hp_scaled,
            duration_days,
            cost_base,
        });
        Ok(())
    }

    pub fn renew_rig(ctx: Context<RenewRig>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let cfg = &mut ctx.accounts.config;
        let mut position = load_position_any(&ctx.accounts.position)?;
        let bump = *ctx.bumps.get("user_profile").unwrap();
        let mut profile = ensure_user_profile_v2(
            &ctx.accounts.user_profile,
            &ctx.accounts.owner.to_account_info(),
            &ctx.accounts.system_program,
            ctx.accounts.owner.key(),
            bump,
            now,
        )?;

        require_keys_eq!(position.owner, ctx.accounts.owner.key(), ErrorCode::Unauthorized);
        update_user_xp(&mut profile, now)?;

        require!(now >= position.end_ts, ErrorCode::PositionNotExpired);
        let grace_deadline = grace_deadline_ts(position.end_ts, cfg.seconds_per_day)?;
        require!(now <= grace_deadline, ErrorCode::PositionGraceExpired);

        let rig_type = position_rig_type(&position, cfg)?;
        let (duration_days, base_hp_scaled, cost_base) = contract_terms(rig_type)?;
        let duration_seconds = (duration_days as i64)
            .checked_mul(cfg.seconds_per_day as i64)
            .ok_or(ErrorCode::MathOverflow)?;

        if !position.expired {
            expire_position(cfg, &mut position, &mut profile, now)?;
        } else {
            update_mining_global(cfg, now)?;
        }

        let new_active_hp = profile
            .active_hp
            .checked_add(base_hp_scaled)
            .ok_or(ErrorCode::MathOverflow)?;
        require!(
            new_active_hp <= cfg
                .max_effective_hp
                .checked_mul(HP_SCALE_U64)
                .ok_or(ErrorCode::MathOverflow)?,
            ErrorCode::MaxEffectiveHpExceeded
        );

        ensure_position_v2(
            &ctx.accounts.position,
            &ctx.accounts.owner.to_account_info(),
            &ctx.accounts.system_program,
        )?;

        position.start_ts = now;
        position.end_ts = now
            .checked_add(duration_seconds)
            .ok_or(ErrorCode::MathOverflow)?;
        position.hp = base_hp_scaled;
        position.hp_scaled = true;
        position.rig_type = rig_type;
        position.expired = false;
        position.deactivated = false;
        position.final_acc_mind_per_hp = 0;

        let buff_bps = position_buff_bps(&position, rig_type, now);
        let hp_effective = effective_hp_scaled(
            base_hp_scaled as u128,
            profile.level,
            buff_bps,
        )?;
        position.reward_debt = earned_per_hp(hp_effective, cfg.acc_mind_per_hp)?;

        profile.active_hp = new_active_hp;
        let hp_effective_u64 = u64::try_from(hp_effective).map_err(|_| ErrorCode::MathOverflow)?;
        cfg.network_hp_active = cfg
            .network_hp_active
            .checked_add(hp_effective_u64)
            .ok_or(ErrorCode::MathOverflow)?;

        let staking_share = (cost_base as u128)
            .checked_mul(STAKING_SHARE_BPS)
            .ok_or(ErrorCode::MathOverflow)?
            .checked_div(BPS_DENOMINATOR)
            .ok_or(ErrorCode::MathOverflow)? as u64;
        let treasury_share = cost_base
            .checked_sub(staking_share)
            .ok_or(ErrorCode::MathOverflow)?;

        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                SystemTransfer {
                    from: ctx.accounts.owner.to_account_info(),
                    to: ctx.accounts.treasury_vault.to_account_info(),
                },
            ),
            treasury_share,
        )?;
        if staking_share > 0 {
            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    SystemTransfer {
                        from: ctx.accounts.owner.to_account_info(),
                        to: ctx.accounts.staking_reward_vault.to_account_info(),
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

        save_position(&ctx.accounts.position, &position)?;
        save_user_profile(&ctx.accounts.user_profile, &profile)?;
        Ok(())
    }

    pub fn renew_rig_with_buff(ctx: Context<RenewRigWithBuff>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let cfg = &mut ctx.accounts.config;
        let mut position = load_position_any(&ctx.accounts.position)?;
        let bump = *ctx.bumps.get("user_profile").unwrap();
        let mut profile = ensure_user_profile_v2(
            &ctx.accounts.user_profile,
            &ctx.accounts.owner.to_account_info(),
            &ctx.accounts.system_program,
            ctx.accounts.owner.key(),
            bump,
            now,
        )?;

        require_keys_eq!(position.owner, ctx.accounts.owner.key(), ErrorCode::Unauthorized);
        update_user_xp(&mut profile, now)?;

        require!(now >= position.end_ts, ErrorCode::PositionNotExpired);
        let grace_deadline = grace_deadline_ts(position.end_ts, cfg.seconds_per_day)?;
        require!(now <= grace_deadline, ErrorCode::PositionGraceExpired);

        let rig_type = position_rig_type(&position, cfg)?;
        let (duration_days, base_hp_scaled, cost_base) = contract_terms(rig_type)?;
        let duration_seconds = (duration_days as i64)
            .checked_mul(cfg.seconds_per_day as i64)
            .ok_or(ErrorCode::MathOverflow)?;

        let max_buff = rig_max_buff_level(rig_type);
        let mut new_buff_level = position.buff_level;
        if new_buff_level < max_buff {
            new_buff_level = new_buff_level
                .checked_add(1)
                .ok_or(ErrorCode::MathOverflow)?;
        }

        if !position.expired {
            expire_position(cfg, &mut position, &mut profile, now)?;
        } else {
            update_mining_global(cfg, now)?;
        }

        let mut base_total_scaled: u128 = 0;
        let mut buffed_total_scaled: u128 = 0;
        for info in ctx.remaining_accounts.iter() {
            let entry = load_position_any(info)?;
            if entry.owner != profile.owner {
                continue;
            }
            if entry.deactivated || entry.expired || now >= entry.end_ts {
                continue;
            }
            if info.key == &ctx.accounts.position.key() {
                continue;
            }
            let rig_type = position_rig_type(&entry, cfg)?;
            let base_hp_scaled = position_base_hp_scaled(&entry)?;
            let buff_bps = position_buff_bps(&entry, rig_type, now);
            base_total_scaled = base_total_scaled
                .checked_add(base_hp_scaled)
                .ok_or(ErrorCode::MathOverflow)?;
            let buffed = apply_bps(base_hp_scaled, buff_bps)?;
            buffed_total_scaled = buffed_total_scaled
                .checked_add(buffed)
                .ok_or(ErrorCode::MathOverflow)?;
        }
        let profile_hp_scaled = profile.active_hp as u128;
        require!(
            base_total_scaled == profile_hp_scaled,
            ErrorCode::InvalidRigBuffPositions
        );

        let renewed_base_hp_scaled = base_hp_scaled as u128;
        let renewed_buff_bps = rig_buff_bps(rig_type, new_buff_level);
        let renewed_buffed_hp_scaled = apply_bps(renewed_base_hp_scaled, renewed_buff_bps)?;

        let base_total_after = base_total_scaled
            .checked_add(renewed_base_hp_scaled)
            .ok_or(ErrorCode::MathOverflow)?;
        let buffed_total_after = buffed_total_scaled
            .checked_add(renewed_buffed_hp_scaled)
            .ok_or(ErrorCode::MathOverflow)?;
        if base_total_after > 0 {
            let bonus_bps = buffed_total_after
                .checked_sub(base_total_after)
                .ok_or(ErrorCode::MathOverflow)?
                .checked_mul(BPS_DENOMINATOR)
                .ok_or(ErrorCode::MathOverflow)?
                .checked_div(base_total_after)
                .ok_or(ErrorCode::MathOverflow)?;
            require!(
                bonus_bps <= RIG_BUFF_CAP_BPS as u128,
                ErrorCode::RigBuffCapExceeded
            );
        }

        let reward_base = (renewed_base_hp_scaled)
            .checked_mul(ctx.accounts.rig_buff_config.mind_per_hp_per_day as u128)
            .ok_or(ErrorCode::MathOverflow)?
            .checked_mul(duration_days as u128)
            .ok_or(ErrorCode::MathOverflow)?
            .checked_div(HP_SCALE)
            .ok_or(ErrorCode::MathOverflow)?;
        let buff_cost = reward_base
            .checked_mul(RIG_BUFF_COST_BPS)
            .ok_or(ErrorCode::MathOverflow)?
            .checked_div(BPS_DENOMINATOR)
            .ok_or(ErrorCode::MathOverflow)?;
        let buff_cost_u64 = u64::try_from(buff_cost).map_err(|_| ErrorCode::MathOverflow)?;
        require!(
            ctx.accounts.owner_mind_ata.amount >= buff_cost_u64,
            ErrorCode::InsufficientBuffFunds
        );

        if buff_cost_u64 > 0 {
            let burn_amount = buff_cost_u64
                .checked_div(2)
                .ok_or(ErrorCode::MathOverflow)?;
            let treasury_amount = buff_cost_u64
                .checked_sub(burn_amount)
                .ok_or(ErrorCode::MathOverflow)?;
            if burn_amount > 0 {
                token::burn(
                    CpiContext::new(
                        ctx.accounts.token_program.to_account_info(),
                        Burn {
                            mint: ctx.accounts.mind_mint.to_account_info(),
                            from: ctx.accounts.owner_mind_ata.to_account_info(),
                            authority: ctx.accounts.owner.to_account_info(),
                        },
                    ),
                    burn_amount,
                )?;
            }
            if treasury_amount > 0 {
                token::transfer(
                    CpiContext::new(
                        ctx.accounts.token_program.to_account_info(),
                        Transfer {
                            from: ctx.accounts.owner_mind_ata.to_account_info(),
                            to: ctx.accounts.treasury_mind_vault.to_account_info(),
                            authority: ctx.accounts.owner.to_account_info(),
                        },
                    ),
                    treasury_amount,
                )?;
            }
        }

        let new_active_hp = profile
            .active_hp
            .checked_add(base_hp_scaled)
            .ok_or(ErrorCode::MathOverflow)?;
        require!(
            new_active_hp <= cfg
                .max_effective_hp
                .checked_mul(HP_SCALE_U64)
                .ok_or(ErrorCode::MathOverflow)?,
            ErrorCode::MaxEffectiveHpExceeded
        );

        ensure_position_v2(
            &ctx.accounts.position,
            &ctx.accounts.owner.to_account_info(),
            &ctx.accounts.system_program,
        )?;

        let buff_applied_from_cycle = if new_buff_level > position.buff_level {
            now as u64
        } else {
            position.buff_applied_from_cycle
        };

        position.start_ts = now;
        position.end_ts = now
            .checked_add(duration_seconds)
            .ok_or(ErrorCode::MathOverflow)?;
        position.hp = base_hp_scaled;
        position.hp_scaled = true;
        position.rig_type = rig_type;
        position.buff_level = new_buff_level;
        position.buff_applied_from_cycle = buff_applied_from_cycle;
        position.expired = false;
        position.deactivated = false;
        position.final_acc_mind_per_hp = 0;

        let buff_bps = position_buff_bps(&position, rig_type, now);
        let hp_effective = effective_hp_scaled(
            base_hp_scaled as u128,
            profile.level,
            buff_bps,
        )?;
        position.reward_debt = earned_per_hp(hp_effective, cfg.acc_mind_per_hp)?;

        profile.active_hp = new_active_hp;
        let hp_effective_u64 = u64::try_from(hp_effective).map_err(|_| ErrorCode::MathOverflow)?;
        cfg.network_hp_active = cfg
            .network_hp_active
            .checked_add(hp_effective_u64)
            .ok_or(ErrorCode::MathOverflow)?;

        let staking_share = (cost_base as u128)
            .checked_mul(STAKING_SHARE_BPS)
            .ok_or(ErrorCode::MathOverflow)?
            .checked_div(BPS_DENOMINATOR)
            .ok_or(ErrorCode::MathOverflow)? as u64;
        let treasury_share = cost_base
            .checked_sub(staking_share)
            .ok_or(ErrorCode::MathOverflow)?;

        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                SystemTransfer {
                    from: ctx.accounts.owner.to_account_info(),
                    to: ctx.accounts.treasury_vault.to_account_info(),
                },
            ),
            treasury_share,
        )?;
        if staking_share > 0 {
            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    SystemTransfer {
                        from: ctx.accounts.owner.to_account_info(),
                        to: ctx.accounts.staking_reward_vault.to_account_info(),
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

        save_position(&ctx.accounts.position, &position)?;
        save_user_profile(&ctx.accounts.user_profile, &profile)?;
        Ok(())
    }

    pub fn claim_mind(ctx: Context<ClaimMind>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let cfg = &mut ctx.accounts.config;
        let mut position = load_position_any(&ctx.accounts.position)?;
        let bump = *ctx.bumps.get("user_profile").unwrap();
        let mut profile = ensure_user_profile_v2(
            &ctx.accounts.user_profile,
            &ctx.accounts.owner.to_account_info(),
            &ctx.accounts.system_program,
            ctx.accounts.owner.key(),
            bump,
            now,
        )?;

        require_keys_eq!(
            position.owner,
            ctx.accounts.owner.key(),
            ErrorCode::Unauthorized
        );
        require_keys_eq!(
            profile.owner,
            ctx.accounts.owner.key(),
            ErrorCode::Unauthorized
        );
        update_user_xp(&mut profile, now)?;

        if !position.deactivated && !position.expired && now >= position.end_ts {
            expire_position(cfg, &mut position, &mut profile, now)?;
        } else {
            update_mining_global(cfg, now)?;
        }

        let (hp_effective, acc_used) = effective_hp_for_claim(&position, profile.level, cfg, now)?;
        let pending = pending_mind(hp_effective, acc_used, position.reward_debt)?;
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

        position.reward_debt = earned_per_hp(hp_effective, acc_used)?;
        save_position(&ctx.accounts.position, &position)?;
        save_user_profile(&ctx.accounts.user_profile, &profile)?;

        emit!(MindClaimed {
            owner: position.owner,
            amount: reward,
        });
        Ok(())
    }

    pub fn deactivate_position(ctx: Context<DeactivatePosition>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let cfg = &mut ctx.accounts.config;
        let mut position = load_position_any(&ctx.accounts.position)?;

        require_keys_eq!(
            position.owner,
            ctx.accounts.owner.key(),
            ErrorCode::Unauthorized
        );

        let bump = *ctx.bumps.get("user_profile").unwrap();
        let mut profile = ensure_user_profile_v2(
            &ctx.accounts.user_profile,
            &ctx.accounts.owner.to_account_info(),
            &ctx.accounts.system_program,
            ctx.accounts.owner.key(),
            bump,
            now,
        )?;
        update_user_xp(&mut profile, now)?;

        require!(now >= position.end_ts, ErrorCode::PositionNotExpired);
        if position.deactivated {
            return Ok(());
        }
        let grace_deadline = grace_deadline_ts(position.end_ts, cfg.seconds_per_day)?;
        require!(now > grace_deadline, ErrorCode::PositionInGrace);

        if !position.expired {
            expire_position(cfg, &mut position, &mut profile, now)?;
        } else {
            update_mining_global(cfg, now)?;
        }

        finalize_position(cfg, &mut position, &mut profile, now)?;
        save_position(&ctx.accounts.position, &position)?;
        save_user_profile(&ctx.accounts.user_profile, &profile)?;
        Ok(())
    }

    pub fn level_up(ctx: Context<LevelUp>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let cfg = &mut ctx.accounts.config;
        update_mining_global(cfg, now)?;

        let bump = *ctx.bumps.get("user_profile").unwrap();
        let mut profile = ensure_user_profile_v2(
            &ctx.accounts.user_profile,
            &ctx.accounts.owner.to_account_info(),
            &ctx.accounts.system_program,
            ctx.accounts.owner.key(),
            bump,
            now,
        )?;
        require_keys_eq!(
            profile.owner,
            ctx.accounts.owner.key(),
            ErrorCode::Unauthorized
        );

        update_user_xp(&mut profile, now)?;

        require!(profile.level < 6, ErrorCode::MaxLevelReached);
        let next_level = profile
            .level
            .checked_add(1)
            .ok_or(ErrorCode::MathOverflow)?;
        let threshold = level_threshold(next_level);
        require!(profile.xp >= threshold, ErrorCode::InsufficientXp);

        let cost = level_up_cost(profile.level);
        require!(cost > 0, ErrorCode::InvalidLevel);
        require!(
            ctx.accounts.owner_mind_ata.amount >= cost,
            ErrorCode::InsufficientLevelUpFunds
        );

        let mut base_total_scaled: u128 = 0;
        let mut buffed_total_scaled: u128 = 0;
        let acc = cfg.acc_mind_per_hp;
        for info in ctx.remaining_accounts.iter() {
            require!(info.is_writable, ErrorCode::InvalidLevelUpPositions);
            let mut position = load_position_any(info)?;
            require_keys_eq!(position.owner, profile.owner, ErrorCode::Unauthorized);
            require!(!position.deactivated, ErrorCode::InvalidLevelUpPositions);
            require!(!position.expired && now < position.end_ts, ErrorCode::InvalidLevelUpPositions);
            let rig_type = position_rig_type(&position, cfg)?;
            let base_hp_scaled = position_base_hp_scaled(&position)?;
            let buff_bps = position_buff_bps(&position, rig_type, now);
            let hp_effective = effective_hp_scaled(base_hp_scaled, profile.level, buff_bps)?;
            position.reward_debt = earned_per_hp(hp_effective, acc)?;
            save_position(info, &position)?;
            base_total_scaled = base_total_scaled
                .checked_add(base_hp_scaled)
                .ok_or(ErrorCode::MathOverflow)?;
            let buffed = apply_bps(base_hp_scaled, buff_bps)?;
            buffed_total_scaled = buffed_total_scaled
                .checked_add(buffed)
                .ok_or(ErrorCode::MathOverflow)?;
        }
        let base_total_u64 =
            u64::try_from(base_total_scaled).map_err(|_| ErrorCode::MathOverflow)?;
        require!(
            base_total_u64 == profile.active_hp,
            ErrorCode::InvalidLevelUpPositions
        );

        let burn_amount = cost.checked_div(2).ok_or(ErrorCode::MathOverflow)?;
        let treasury_amount = cost
            .checked_sub(burn_amount)
            .ok_or(ErrorCode::MathOverflow)?;
        if burn_amount > 0 {
            token::burn(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Burn {
                        mint: ctx.accounts.mind_mint.to_account_info(),
                        from: ctx.accounts.owner_mind_ata.to_account_info(),
                        authority: ctx.accounts.owner.to_account_info(),
                    },
                ),
                burn_amount,
            )?;
        }
        if treasury_amount > 0 {
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.owner_mind_ata.to_account_info(),
                        to: ctx.accounts.treasury_mind_vault.to_account_info(),
                        authority: ctx.accounts.owner.to_account_info(),
                    },
                ),
                treasury_amount,
            )?;
        }

        if buffed_total_scaled > 0 {
            let old_bonus = level_bonus_bps(profile.level);
            let new_bonus = level_bonus_bps(next_level);
            let old_effective = apply_bps(buffed_total_scaled, old_bonus)?;
            let new_effective = apply_bps(buffed_total_scaled, new_bonus)?;
            let delta = new_effective
                .checked_sub(old_effective)
                .ok_or(ErrorCode::MathOverflow)?;
            let delta_u64 = u64::try_from(delta).map_err(|_| ErrorCode::MathOverflow)?;
            cfg.network_hp_active = cfg
                .network_hp_active
                .checked_add(delta_u64)
                .ok_or(ErrorCode::MathOverflow)?;
        }

        profile.level = next_level;
        save_user_profile(&ctx.accounts.user_profile, &profile)?;
        Ok(())
    }

    pub fn stake_mind(ctx: Context<StakeMind>, amount: u64) -> Result<()> {
        require!(amount > 0, ErrorCode::InvalidAmount);
        let now = Clock::get()?.unix_timestamp;
        let cfg = &mut ctx.accounts.config;
        update_staking_global(cfg, now)?;

        let bump = *ctx.bumps.get("user_profile").unwrap();
        let profile = ensure_user_profile_v2(
            &ctx.accounts.user_profile,
            &ctx.accounts.owner.to_account_info(),
            &ctx.accounts.system_program,
            ctx.accounts.owner.key(),
            bump,
            now,
        )?;
        require_keys_eq!(
            profile.owner,
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
        require_keys_eq!(
            ctx.accounts.user_stake.owner,
            ctx.accounts.owner.key(),
            ErrorCode::Unauthorized
        );

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

        let burn_amount = (amount as u128)
            .checked_mul(UNSTAKE_BURN_BPS)
            .ok_or(ErrorCode::MathOverflow)?
            .checked_div(BPS_DENOMINATOR)
            .ok_or(ErrorCode::MathOverflow)?;
        let burn_amount = u64::try_from(burn_amount).map_err(|_| ErrorCode::MathOverflow)?;
        let transfer_amount = amount
            .checked_sub(burn_amount)
            .ok_or(ErrorCode::MathOverflow)?;

        let signer_seeds: &[&[u8]] = &[VAULT_SEED, &[cfg.bumps.vault_authority]];
        if burn_amount > 0 {
            token::burn(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Burn {
                        mint: ctx.accounts.mind_mint.to_account_info(),
                        from: ctx.accounts.staking_mind_vault.to_account_info(),
                        authority: ctx.accounts.vault_authority.to_account_info(),
                    },
                    &[signer_seeds],
                ),
                burn_amount,
            )?;
        }
        if transfer_amount > 0 {
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
                transfer_amount,
            )?;
        }

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

        let bump = *ctx.bumps.get("user_profile").unwrap();
        let profile = ensure_user_profile_v2(
            &ctx.accounts.user_profile,
            &ctx.accounts.owner.to_account_info(),
            &ctx.accounts.system_program,
            ctx.accounts.owner.key(),
            bump,
            now,
        )?;
        require_keys_eq!(
            profile.owner,
            ctx.accounts.owner.key(),
            ErrorCode::Unauthorized
        );

        let pending_base = pending_stake(cfg, &ctx.accounts.user_stake)?;
        let base_total = pending_base
            .checked_add(ctx.accounts.user_stake.reward_owed as u128)
            .ok_or(ErrorCode::MathOverflow)?;
        require!(base_total > 0, ErrorCode::NothingToClaim);

        let bonus_bps = profile.badge_bonus_bps.min(BADGE_BONUS_CAP_BPS) as u128;
        let payout = base_total
            .checked_mul(BPS_DENOMINATOR + bonus_bps)
            .ok_or(ErrorCode::MathOverflow)?
            .checked_div(BPS_DENOMINATOR)
            .ok_or(ErrorCode::MathOverflow)?;
        let payout_u64 = u64::try_from(payout).map_err(|_| ErrorCode::MathOverflow)?;

        let available = vault_available_lamports(&ctx.accounts.staking_reward_vault)?;
        require!(available >= payout_u64, ErrorCode::InsufficientVaultBalance);

        transfer_lamports(
            &ctx.accounts.staking_reward_vault.to_account_info(),
            &ctx.accounts.owner.to_account_info(),
            payout_u64,
        )?;

        ctx.accounts.user_stake.reward_owed = 0;
        ctx.accounts.user_stake.reward_debt = earned_per_stake(
            ctx.accounts.user_stake.staked_mind,
            cfg.staking_acc_xnt_per_mind,
        )?;

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

        let vault_balance = vault_available_lamports(&ctx.accounts.staking_reward_vault)?;
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

    pub fn admin_set_network_hp_active(
        ctx: Context<AdminSetNetworkHpActive>,
        network_hp_active: u64,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let cfg = &mut ctx.accounts.config;
        require_keys_eq!(cfg.admin, ctx.accounts.admin.key(), ErrorCode::Unauthorized);
        update_mining_global(cfg, now)?;
        cfg.network_hp_active = network_hp_active;
        Ok(())
    }

    pub fn admin_enable_hp_scaling(ctx: Context<AdminEnableHpScaling>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let cfg = &mut ctx.accounts.config;
        require_keys_eq!(cfg.admin, ctx.accounts.admin.key(), ErrorCode::Unauthorized);
        if ctx.accounts.hp_scale_config.enabled {
            return Err(ErrorCode::HpScaleAlreadyEnabled.into());
        }

        update_mining_global(cfg, now)?;

        cfg.network_hp_active = cfg
            .network_hp_active
            .checked_mul(HP_SCALE_U64)
            .ok_or(ErrorCode::MathOverflow)?;
        cfg.acc_mind_per_hp = cfg
            .acc_mind_per_hp
            .checked_div(HP_SCALE)
            .ok_or(ErrorCode::MathOverflow)?;

        ctx.accounts.hp_scale_config.enabled = true;
        ctx.accounts.hp_scale_config.bump = *ctx.bumps.get("hp_scale_config").unwrap();
        Ok(())
    }

    pub fn admin_use_native_xnt(ctx: Context<AdminUseNativeXnt>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let cfg = &mut ctx.accounts.config;
        require_keys_eq!(cfg.admin, ctx.accounts.admin.key(), ErrorCode::Unauthorized);

        cfg.xnt_mint = System::id();
        cfg.staking_reward_vault = ctx.accounts.staking_reward_vault.key();
        cfg.treasury_vault = ctx.accounts.treasury_vault.key();

        ctx.accounts.staking_reward_vault.bump =
            *ctx.bumps.get("staking_reward_vault").unwrap();
        ctx.accounts.treasury_vault.bump = *ctx.bumps.get("treasury_vault").unwrap();

        // Reset staking epoch accounting to align with the native reward vault.
        cfg.staking_accounted_balance = vault_available_lamports(&ctx.accounts.staking_reward_vault)?;
        cfg.staking_undistributed_xnt = 0;
        cfg.staking_reward_rate_xnt_per_sec = 0;
        cfg.staking_epoch_end_ts = now;
        cfg.staking_last_update_ts = now;
        Ok(())
    }

    pub fn admin_withdraw_treasury(
        ctx: Context<AdminWithdrawTreasury>,
        amount: u64,
    ) -> Result<()> {
        require!(amount > 0, ErrorCode::InvalidAmount);
        let cfg = &ctx.accounts.config;
        require_keys_eq!(cfg.admin, ctx.accounts.admin.key(), ErrorCode::Unauthorized);
        let available = vault_available_lamports(&ctx.accounts.treasury_vault)?;
        require!(available >= amount, ErrorCode::InsufficientVaultBalance);

        transfer_lamports(
            &ctx.accounts.treasury_vault.to_account_info(),
            &ctx.accounts.admin.to_account_info(),
            amount,
        )?;
        Ok(())
    }

    pub fn admin_set_badge(
        ctx: Context<AdminSetBadge>,
        badge_tier: u8,
        badge_bonus_bps: u16,
    ) -> Result<()> {
        let cfg = &ctx.accounts.config;
        require_keys_eq!(cfg.admin, ctx.accounts.admin.key(), ErrorCode::Unauthorized);
        let now = Clock::get()?.unix_timestamp;
        let bump = *ctx.bumps.get("user_profile").unwrap();
        let mut profile = ensure_user_profile_v2(
            &ctx.accounts.user_profile,
            &ctx.accounts.admin.to_account_info(),
            &ctx.accounts.system_program,
            ctx.accounts.user.key(),
            bump,
            now,
        )?;
        require_keys_eq!(
            profile.owner,
            ctx.accounts.user.key(),
            ErrorCode::Unauthorized
        );
        profile.badge_tier = badge_tier;
        profile.badge_bonus_bps = badge_bonus_bps.min(BADGE_BONUS_CAP_BPS);
        save_user_profile(&ctx.accounts.user_profile, &profile)?;
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
    pub mind_mint: Box<Account<'info, Mint>>,
    #[account(
        init,
        payer = payer,
        space = 8 + NativeVault::INIT_SPACE,
        seeds = [STAKING_REWARD_VAULT_SEED],
        bump
    )]
    pub staking_reward_vault: Box<Account<'info, NativeVault>>,
    #[account(
        init,
        payer = payer,
        space = 8 + NativeVault::INIT_SPACE,
        seeds = [TREASURY_VAULT_SEED],
        bump
    )]
    pub treasury_vault: Box<Account<'info, NativeVault>>,
    #[account(
        constraint = staking_mind_vault.owner == vault_authority.key(),
        constraint = staking_mind_vault.mint == mind_mint.key()
    )]
    pub staking_mind_vault: Box<Account<'info, TokenAccount>>,
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

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitRigBuffConfigParams {
    pub mind_per_hp_per_day: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct UpdateRigBuffConfigParams {
    pub mind_per_hp_per_day: u64,
}

#[derive(Accounts)]
pub struct InitLevelConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bumps.config
    )]
    pub config: Box<Account<'info, Config>>,
    #[account(
        init_if_needed,
        payer = admin,
        space = 8 + LevelConfig::INIT_SPACE,
        seeds = [LEVEL_CONFIG_SEED],
        bump
    )]
    pub level_config: Box<Account<'info, LevelConfig>>,
    #[account(
        constraint = mind_mint.key() == config.mind_mint
    )]
    pub mind_mint: Account<'info, Mint>,
    #[account(
        constraint = mind_burn_vault.mint == mind_mint.key()
    )]
    pub mind_burn_vault: Account<'info, TokenAccount>,
    #[account(
        constraint = mind_treasury_vault.mint == mind_mint.key()
    )]
    pub mind_treasury_vault: Account<'info, TokenAccount>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitRigBuffConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bumps.config
    )]
    pub config: Box<Account<'info, Config>>,
    #[account(
        init_if_needed,
        payer = admin,
        space = 8 + RigBuffConfig::INIT_SPACE,
        seeds = [RIG_BUFF_CONFIG_SEED],
        bump
    )]
    pub rig_buff_config: Box<Account<'info, RigBuffConfig>>,
    #[account(
        constraint = mind_mint.key() == config.mind_mint
    )]
    pub mind_mint: Account<'info, Mint>,
    #[account(
        constraint = mind_burn_vault.mint == mind_mint.key()
    )]
    pub mind_burn_vault: Account<'info, TokenAccount>,
    #[account(
        constraint = mind_treasury_vault.mint == mind_mint.key()
    )]
    pub mind_treasury_vault: Account<'info, TokenAccount>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminUpdateRigBuffConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        seeds = [RIG_BUFF_CONFIG_SEED],
        bump = rig_buff_config.bump
    )]
    pub rig_buff_config: Box<Account<'info, RigBuffConfig>>,
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
        mut,
        seeds = [PROFILE_SEED, owner.key().as_ref()],
        bump
    )]
    /// CHECK: PDA derived from PROFILE_SEED; validated in instruction handlers.
    pub user_profile: UncheckedAccount<'info>,
    #[account(
        init,
        payer = owner,
        space = 8 + MinerPosition::INIT_SPACE,
        seeds = [POSITION_SEED, owner.key().as_ref(), position_index.to_le_bytes().as_ref()],
        bump
    )]
    pub position: Box<Account<'info, MinerPosition>>,
    #[account(
        mut,
        seeds = [STAKING_REWARD_VAULT_SEED],
        bump,
        constraint = staking_reward_vault.key() == config.staking_reward_vault
    )]
    pub staking_reward_vault: Account<'info, NativeVault>,
    #[account(
        mut,
        seeds = [TREASURY_VAULT_SEED],
        bump,
        constraint = treasury_vault.key() == config.treasury_vault
    )]
    pub treasury_vault: Account<'info, NativeVault>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RenewRig<'info> {
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
        bump
    )]
    /// CHECK: PDA derived from PROFILE_SEED; validated in instruction handlers.
    pub user_profile: UncheckedAccount<'info>,
    #[account(mut)]
    /// CHECK: Manual position decoding supports legacy sizes.
    pub position: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [STAKING_REWARD_VAULT_SEED],
        bump,
        constraint = staking_reward_vault.key() == config.staking_reward_vault
    )]
    pub staking_reward_vault: Account<'info, NativeVault>,
    #[account(
        mut,
        seeds = [TREASURY_VAULT_SEED],
        bump,
        constraint = treasury_vault.key() == config.treasury_vault
    )]
    pub treasury_vault: Account<'info, NativeVault>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RenewRigWithBuff<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bumps.config
    )]
    pub config: Box<Account<'info, Config>>,
    #[account(
        seeds = [RIG_BUFF_CONFIG_SEED],
        bump = rig_buff_config.bump,
        constraint = rig_buff_config.mind_mint == config.mind_mint
    )]
    pub rig_buff_config: Box<Account<'info, RigBuffConfig>>,
    #[account(
        mut,
        seeds = [PROFILE_SEED, owner.key().as_ref()],
        bump
    )]
    /// CHECK: PDA derived from PROFILE_SEED; validated in instruction handlers.
    pub user_profile: UncheckedAccount<'info>,
    #[account(mut)]
    /// CHECK: Manual position decoding supports legacy sizes.
    pub position: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [STAKING_REWARD_VAULT_SEED],
        bump,
        constraint = staking_reward_vault.key() == config.staking_reward_vault
    )]
    pub staking_reward_vault: Account<'info, NativeVault>,
    #[account(
        mut,
        seeds = [TREASURY_VAULT_SEED],
        bump,
        constraint = treasury_vault.key() == config.treasury_vault
    )]
    pub treasury_vault: Account<'info, NativeVault>,
    #[account(
        mut,
        constraint = mind_mint.key() == config.mind_mint
    )]
    pub mind_mint: Account<'info, Mint>,
    #[account(
        mut,
        constraint = owner_mind_ata.owner == owner.key(),
        constraint = owner_mind_ata.mint == config.mind_mint
    )]
    pub owner_mind_ata: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = burn_mind_vault.key() == rig_buff_config.mind_burn_vault,
        constraint = burn_mind_vault.mint == config.mind_mint
    )]
    pub burn_mind_vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = treasury_mind_vault.key() == rig_buff_config.mind_treasury_vault,
        constraint = treasury_mind_vault.mint == config.mind_mint
    )]
    pub treasury_mind_vault: Account<'info, TokenAccount>,
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
        bump
    )]
    /// CHECK: PDA derived from PROFILE_SEED; validated in instruction handlers.
    pub user_profile: UncheckedAccount<'info>,
    #[account(mut)]
    /// CHECK: Manual position decoding supports legacy sizes.
    pub position: UncheckedAccount<'info>,
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
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DeactivatePosition<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bumps.config
    )]
    pub config: Box<Account<'info, Config>>,
    #[account(mut)]
    /// CHECK: Manual position decoding supports legacy sizes.
    pub position: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [PROFILE_SEED, owner.key().as_ref()],
        bump
    )]
    /// CHECK: PDA derived from PROFILE_SEED; validated in instruction handlers.
    pub user_profile: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct LevelUp<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bumps.config
    )]
    pub config: Box<Account<'info, Config>>,
    #[account(
        seeds = [LEVEL_CONFIG_SEED],
        bump = level_config.bump,
        constraint = level_config.admin == config.admin,
        constraint = level_config.mind_mint == config.mind_mint
    )]
    pub level_config: Box<Account<'info, LevelConfig>>,
    #[account(
        mut,
        constraint = mind_mint.key() == config.mind_mint
    )]
    pub mind_mint: Account<'info, Mint>,
    #[account(
        mut,
        seeds = [PROFILE_SEED, owner.key().as_ref()],
        bump
    )]
    /// CHECK: PDA derived from PROFILE_SEED; validated in instruction handlers.
    pub user_profile: UncheckedAccount<'info>,
    #[account(
        mut,
        constraint = owner_mind_ata.owner == owner.key(),
        constraint = owner_mind_ata.mint == config.mind_mint
    )]
    pub owner_mind_ata: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = burn_mind_vault.key() == level_config.mind_burn_vault,
        constraint = burn_mind_vault.mint == config.mind_mint
    )]
    pub burn_mind_vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = treasury_mind_vault.key() == level_config.mind_treasury_vault,
        constraint = treasury_mind_vault.mint == config.mind_mint
    )]
    pub treasury_mind_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
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
        mut,
        seeds = [PROFILE_SEED, owner.key().as_ref()],
        bump
    )]
    /// CHECK: PDA derived from PROFILE_SEED; validated in instruction handlers.
    pub user_profile: UncheckedAccount<'info>,
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
        constraint = config.mind_mint == mind_mint.key()
    )]
    pub mind_mint: Account<'info, Mint>,
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
        mut,
        seeds = [PROFILE_SEED, owner.key().as_ref()],
        bump
    )]
    /// CHECK: PDA derived from PROFILE_SEED; validated in instruction handlers.
    pub user_profile: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [STAKE_SEED, owner.key().as_ref()],
        bump = user_stake.bump,
        constraint = user_stake.owner == owner.key()
    )]
    pub user_stake: Box<Account<'info, UserStake>>,
    #[account(
        mut,
        seeds = [STAKING_REWARD_VAULT_SEED],
        bump,
        constraint = staking_reward_vault.key() == config.staking_reward_vault
    )]
    pub staking_reward_vault: Account<'info, NativeVault>,
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
        seeds = [STAKING_REWARD_VAULT_SEED],
        bump,
        constraint = staking_reward_vault.key() == config.staking_reward_vault
    )]
    pub staking_reward_vault: Account<'info, NativeVault>,
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
pub struct AdminSetNetworkHpActive<'info> {
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
pub struct AdminEnableHpScaling<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bumps.config
    )]
    pub config: Box<Account<'info, Config>>,
    #[account(
        init_if_needed,
        payer = admin,
        space = 8 + HpScaleConfig::INIT_SPACE,
        seeds = [HP_SCALE_SEED],
        bump
    )]
    pub hp_scale_config: Box<Account<'info, HpScaleConfig>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminUseNativeXnt<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bumps.config
    )]
    pub config: Box<Account<'info, Config>>,
    #[account(
        init_if_needed,
        payer = admin,
        space = 8 + NativeVault::INIT_SPACE,
        seeds = [STAKING_REWARD_VAULT_SEED],
        bump
    )]
    pub staking_reward_vault: Account<'info, NativeVault>,
    #[account(
        init_if_needed,
        payer = admin,
        space = 8 + NativeVault::INIT_SPACE,
        seeds = [TREASURY_VAULT_SEED],
        bump
    )]
    pub treasury_vault: Account<'info, NativeVault>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminWithdrawTreasury<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bumps.config
    )]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut,
        seeds = [TREASURY_VAULT_SEED],
        bump,
        constraint = treasury_vault.key() == config.treasury_vault
    )]
    pub treasury_vault: Account<'info, NativeVault>,
    pub system_program: Program<'info, System>,
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
        mut,
        seeds = [PROFILE_SEED, user.key().as_ref()],
        bump
    )]
    /// CHECK: PDA derived from PROFILE_SEED; validated in instruction handlers.
    pub user_profile: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[account]
#[derive(InitSpace)]
pub struct NativeVault {
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
pub struct UserMiningProfileV1 {
    pub owner: Pubkey,
    pub next_position_index: u64,
    pub active_hp: u64,
    pub xp: u64,
    pub badge_tier: u8,
    pub badge_bonus_bps: u16,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
pub struct UserMiningProfileV2Legacy {
    pub owner: Pubkey,
    pub next_position_index: u64,
    pub active_hp: u64,
    pub xp: u64,
    pub badge_tier: u8,
    pub badge_bonus_bps: u16,
    pub bump: u8,
    pub level: u8,
    pub last_xp_update_ts: i64,
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
pub struct LevelConfig {
    pub admin: Pubkey,
    pub mind_mint: Pubkey,
    pub mind_burn_vault: Pubkey,
    pub mind_treasury_vault: Pubkey,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct RigBuffConfig {
    pub admin: Pubkey,
    pub mind_mint: Pubkey,
    pub mind_burn_vault: Pubkey,
    pub mind_treasury_vault: Pubkey,
    pub mind_per_hp_per_day: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct HpScaleConfig {
    pub enabled: bool,
    pub bump: u8,
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
    pub level: u8,
    pub last_xp_update_ts: i64,
    pub hp_scaled: bool,
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
    pub rig_type: u8,
    pub buff_level: u8,
    pub hp_scaled: bool,
    pub expired: bool,
    pub buff_applied_from_cycle: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
pub struct MinerPositionV1 {
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

fn level_bonus_bps(level: u8) -> u16 {
    match level {
        0 | 1 => 0,
        2 => 160,
        3 => 340,
        4 => 550,
        5 => 780,
        _ => LEVEL_BONUS_CAP_BPS,
    }
}

fn level_threshold(level: u8) -> u64 {
    match level {
        1 => 0,
        2 => 1,
        3 => 2_000,
        4 => 5_000,
        5 => 10_000,
        _ => 16_000,
    }
}

fn level_up_cost(level: u8) -> u64 {
    match level {
        1 => 150_u64 * MIND_DECIMALS,
        2 => 350_u64 * MIND_DECIMALS,
        3 => 900_u64 * MIND_DECIMALS,
        4 => 2_000_u64 * MIND_DECIMALS,
        5 => 4_000_u64 * MIND_DECIMALS,
        _ => 0,
    }
}

fn apply_bps(amount: u128, bps: u16) -> Result<u128> {
    amount
        .checked_mul(BPS_DENOMINATOR + bps as u128)
        .ok_or(ErrorCode::MathOverflow)?
        .checked_div(BPS_DENOMINATOR)
        .ok_or(ErrorCode::MathOverflow.into())
}

fn position_base_hp_scaled(position: &PositionData) -> Result<u128> {
    if position.hp_scaled {
        Ok(position.hp as u128)
    } else {
        (position.hp as u128)
            .checked_mul(HP_SCALE)
            .ok_or(ErrorCode::MathOverflow.into())
    }
}

fn rig_type_from_duration(start_ts: i64, end_ts: i64, seconds_per_day: u64) -> Result<u8> {
    require!(end_ts > start_ts, ErrorCode::InvalidRigDuration);
    let duration = end_ts
        .checked_sub(start_ts)
        .ok_or(ErrorCode::MathOverflow)?;
    let seconds_per_day_i64 = seconds_per_day as i64;
    require!(seconds_per_day_i64 > 0, ErrorCode::InvalidRigDuration);
    let days = duration / seconds_per_day_i64;
    match days {
        7 => Ok(0),
        14 => Ok(1),
        28 => Ok(2),
        _ => Err(ErrorCode::InvalidRigDuration.into()),
    }
}

fn position_rig_type(position: &PositionData, cfg: &Config) -> Result<u8> {
    if position.version >= 2 {
        return Ok(position.rig_type);
    }
    rig_type_from_duration(position.start_ts, position.end_ts, cfg.seconds_per_day)
}

fn rig_max_buff_level(rig_type: u8) -> u8 {
    match rig_type {
        0 => 1,
        1 | 2 => 3,
        _ => 0,
    }
}

fn rig_buff_bps(rig_type: u8, buff_level: u8) -> u16 {
    match rig_type {
        0 => match buff_level {
            0 => 0,
            _ => 100,
        },
        1 => match buff_level {
            0 => 0,
            1 => 100,
            2 => 200,
            _ => 350,
        },
        2 => match buff_level {
            0 => 0,
            1 => 150,
            2 => 300,
            _ => 500,
        },
        _ => 0,
    }
}

fn position_buff_bps(position: &PositionData, rig_type: u8, now: i64) -> u16 {
    if position.buff_level == 0 {
        return 0;
    }
    if position.buff_applied_from_cycle == 0 {
        return rig_buff_bps(rig_type, position.buff_level);
    }
    let now_u64 = now.max(0) as u64;
    if now_u64 >= position.buff_applied_from_cycle {
        rig_buff_bps(rig_type, position.buff_level)
    } else {
        0
    }
}

fn effective_hp_scaled(
    base_hp_scaled: u128,
    level: u8,
    rig_buff_bps: u16,
) -> Result<u128> {
    let with_rig_buff = apply_bps(base_hp_scaled, rig_buff_bps)?;
    let level_bonus = level_bonus_bps(level);
    apply_bps(with_rig_buff, level_bonus)
}

fn effective_hp_for_claim(
    position: &PositionData,
    profile_level: u8,
    cfg: &Config,
    now: i64,
) -> Result<(u128, u128)> {
    if position.deactivated {
        if position.hp & HP_SCALED_MARKER != 0 {
            let hp_scaled = (position.hp & !HP_SCALED_MARKER) as u128;
            return Ok((hp_scaled, position.final_acc_mind_per_hp));
        }
        let hp = position.hp as u128;
        let acc = position.final_acc_mind_per_hp;
        let hp_scaled = hp.checked_mul(HP_SCALE).ok_or(ErrorCode::MathOverflow)?;
        let acc_scaled = acc.checked_div(HP_SCALE).ok_or(ErrorCode::MathOverflow)?;
        return Ok((hp_scaled, acc_scaled));
    }
    let rig_type = position_rig_type(position, cfg)?;
    let base_hp_scaled = position_base_hp_scaled(position)?;
    let buff_bps = position_buff_bps(position, rig_type, now);
    let hp_effective = effective_hp_scaled(base_hp_scaled, profile_level, buff_bps)?;
    let acc = if position.expired {
        position.final_acc_mind_per_hp
    } else {
        cfg.acc_mind_per_hp
    };
    Ok((hp_effective, acc))
}

fn update_user_xp(profile: &mut UserMiningProfile, now: i64) -> Result<()> {
    if profile.level == 0 {
        profile.xp = 0;
        profile.level = 1;
        profile.last_xp_update_ts = now;
        return Ok(());
    }
    let delta = now
        .checked_sub(profile.last_xp_update_ts)
        .ok_or(ErrorCode::MathOverflow)?;
    if delta <= 0 {
        return Ok(());
    }
    let base_hp_scaled = if profile.hp_scaled {
        profile.active_hp as u128
    } else {
        (profile.active_hp as u128)
            .checked_mul(HP_SCALE)
            .ok_or(ErrorCode::MathOverflow)?
    };
    let delta_u128 = delta as u128;
    let denom = (XP_SECONDS_PER_POINT_DENOMINATOR as u128)
        .checked_mul(HP_SCALE)
        .ok_or(ErrorCode::MathOverflow)?;
    let gained = base_hp_scaled
        .checked_mul(delta_u128)
        .ok_or(ErrorCode::MathOverflow)?
        .checked_div(denom)
        .ok_or(ErrorCode::MathOverflow)?;
    let gained_u64 = u64::try_from(gained).map_err(|_| ErrorCode::MathOverflow)?;
    profile.xp = profile
        .xp
        .checked_add(gained_u64)
        .ok_or(ErrorCode::MathOverflow)?;
    profile.last_xp_update_ts = now;
    Ok(())
}

fn init_profile_defaults(
    profile: &mut UserMiningProfile,
    owner: Pubkey,
    bump: u8,
    now: i64,
) {
    if profile.owner == Pubkey::default() {
        profile.owner = owner;
        profile.next_position_index = 0;
        profile.active_hp = 0;
        profile.xp = 0;
        profile.badge_tier = 0;
        profile.badge_bonus_bps = 0;
        profile.bump = bump;
        profile.level = 1;
        profile.last_xp_update_ts = now;
        profile.hp_scaled = true;
        return;
    }
    if profile.level == 0 {
        profile.xp = 0;
        profile.level = 1;
        profile.last_xp_update_ts = now;
    }
}

fn ensure_profile_hp_scaled(profile: &mut UserMiningProfile) -> Result<()> {
    if profile.hp_scaled {
        return Ok(());
    }
    profile.active_hp = profile
        .active_hp
        .checked_mul(HP_SCALE_U64)
        .ok_or(ErrorCode::MathOverflow)?;
    profile.hp_scaled = true;
    Ok(())
}

fn load_user_profile_any(info: &AccountInfo) -> Result<UserMiningProfile> {
    require!(
        info.owner == &crate::ID,
        ErrorCode::InvalidUserProfileOwner
    );
    let data = info.try_borrow_data()?;
    require!(data.len() >= 8, ErrorCode::InvalidUserProfileSize);
    require!(
        data[..8] == UserMiningProfile::DISCRIMINATOR,
        ErrorCode::InvalidUserProfileDiscriminator
    );
    if data.len() >= 8 + UserMiningProfile::INIT_SPACE {
        let mut slice: &[u8] = &data;
        return UserMiningProfile::try_deserialize(&mut slice);
    }
    if data.len() == 8 + UserMiningProfileV2Legacy::INIT_SPACE {
        let mut slice: &[u8] = &data[8..];
        let legacy = UserMiningProfileV2Legacy::deserialize(&mut slice)
            .map_err(|_| ErrorCode::InvalidUserProfileSize)?;
        return Ok(UserMiningProfile {
            owner: legacy.owner,
            next_position_index: legacy.next_position_index,
            active_hp: legacy.active_hp,
            xp: legacy.xp,
            badge_tier: legacy.badge_tier,
            badge_bonus_bps: legacy.badge_bonus_bps,
            bump: legacy.bump,
            level: legacy.level,
            last_xp_update_ts: legacy.last_xp_update_ts,
            hp_scaled: false,
        });
    }
    if data.len() == 8 + UserMiningProfileV1::INIT_SPACE {
        let mut slice: &[u8] = &data[8..];
        let legacy = UserMiningProfileV1::deserialize(&mut slice)
            .map_err(|_| ErrorCode::InvalidUserProfileSize)?;
        return Ok(UserMiningProfile {
            owner: legacy.owner,
            next_position_index: legacy.next_position_index,
            active_hp: legacy.active_hp,
            xp: legacy.xp,
            badge_tier: legacy.badge_tier,
            badge_bonus_bps: legacy.badge_bonus_bps,
            bump: legacy.bump,
            level: 0,
            last_xp_update_ts: 0,
            hp_scaled: false,
        });
    }
    Err(ErrorCode::InvalidUserProfileSize.into())
}

fn save_user_profile(info: &AccountInfo, profile: &UserMiningProfile) -> Result<()> {
    let mut data = info.try_borrow_mut_data()?;
    let len = data.len();
    if len >= 8 + UserMiningProfile::INIT_SPACE {
        let mut cursor: &mut [u8] = &mut data;
        profile.try_serialize(&mut cursor)?;
        return Ok(());
    }
    if len == 8 + UserMiningProfileV2Legacy::INIT_SPACE {
        let legacy = UserMiningProfileV2Legacy {
            owner: profile.owner,
            next_position_index: profile.next_position_index,
            active_hp: profile.active_hp,
            xp: profile.xp,
            badge_tier: profile.badge_tier,
            badge_bonus_bps: profile.badge_bonus_bps,
            bump: profile.bump,
            level: profile.level,
            last_xp_update_ts: profile.last_xp_update_ts,
        };
        data[..8].copy_from_slice(&UserMiningProfile::DISCRIMINATOR);
        let mut cursor: &mut [u8] = &mut data[8..];
        legacy
            .serialize(&mut cursor)
            .map_err(|_| ErrorCode::InvalidUserProfileSize.into())
    } else if len == 8 + UserMiningProfileV1::INIT_SPACE {
        let legacy = UserMiningProfileV1 {
            owner: profile.owner,
            next_position_index: profile.next_position_index,
            active_hp: profile.active_hp,
            xp: profile.xp,
            badge_tier: profile.badge_tier,
            badge_bonus_bps: profile.badge_bonus_bps,
            bump: profile.bump,
        };
        data[..8].copy_from_slice(&UserMiningProfile::DISCRIMINATOR);
        let mut cursor: &mut [u8] = &mut data[8..];
        legacy
            .serialize(&mut cursor)
            .map_err(|_| ErrorCode::InvalidUserProfileSize.into())
    } else {
        Err(ErrorCode::InvalidUserProfileSize.into())
    }
}

struct PositionData {
    owner: Pubkey,
    hp: u64,
    start_ts: i64,
    end_ts: i64,
    reward_debt: u128,
    final_acc_mind_per_hp: u128,
    deactivated: bool,
    bump: u8,
    rig_type: u8,
    buff_level: u8,
    hp_scaled: bool,
    expired: bool,
    buff_applied_from_cycle: u64,
    version: u8,
}

fn load_position_any(info: &AccountInfo) -> Result<PositionData> {
    require!(info.owner == &crate::ID, ErrorCode::InvalidPositionOwner);
    let data = info.try_borrow_data()?;
    require!(data.len() >= 8, ErrorCode::InvalidPositionSize);
    require!(
        data[..8] == MinerPosition::DISCRIMINATOR,
        ErrorCode::InvalidPositionDiscriminator
    );
    let v2_size = 8 + MinerPosition::INIT_SPACE;
    let v1_size = 8 + MinerPositionV1::INIT_SPACE;
    if data.len() >= v2_size {
        let mut slice: &[u8] = &data;
        let position = MinerPosition::try_deserialize(&mut slice)
            .map_err(|_| ErrorCode::InvalidPositionSize)?;
        return Ok(PositionData {
            owner: position.owner,
            hp: position.hp,
            start_ts: position.start_ts,
            end_ts: position.end_ts,
            reward_debt: position.reward_debt,
            final_acc_mind_per_hp: position.final_acc_mind_per_hp,
            deactivated: position.deactivated,
            bump: position.bump,
            rig_type: position.rig_type,
            buff_level: position.buff_level,
            hp_scaled: position.hp_scaled,
            expired: position.expired,
            buff_applied_from_cycle: position.buff_applied_from_cycle,
            version: 2,
        });
    }
    if data.len() == v1_size {
        let mut slice: &[u8] = &data[8..];
        let position = MinerPositionV1::deserialize(&mut slice)
            .map_err(|_| ErrorCode::InvalidPositionSize)?;
        return Ok(PositionData {
            owner: position.owner,
            hp: position.hp,
            start_ts: position.start_ts,
            end_ts: position.end_ts,
            reward_debt: position.reward_debt,
            final_acc_mind_per_hp: position.final_acc_mind_per_hp,
            deactivated: position.deactivated,
            bump: position.bump,
            rig_type: 0,
            buff_level: 0,
            hp_scaled: false,
            expired: false,
            buff_applied_from_cycle: 0,
            version: 1,
        });
    }
    Err(ErrorCode::InvalidPositionSize.into())
}

fn save_position(info: &AccountInfo, position: &PositionData) -> Result<()> {
    let mut data = info.try_borrow_mut_data()?;
    let v2_size = 8 + MinerPosition::INIT_SPACE;
    let v1_size = 8 + MinerPositionV1::INIT_SPACE;
    if data.len() >= v2_size {
        let upgraded = MinerPosition {
            owner: position.owner,
            hp: position.hp,
            start_ts: position.start_ts,
            end_ts: position.end_ts,
            reward_debt: position.reward_debt,
            final_acc_mind_per_hp: position.final_acc_mind_per_hp,
            deactivated: position.deactivated,
            bump: position.bump,
            rig_type: position.rig_type,
            buff_level: position.buff_level,
            hp_scaled: position.hp_scaled,
            expired: position.expired,
            buff_applied_from_cycle: position.buff_applied_from_cycle,
        };
        let mut cursor: &mut [u8] = &mut data;
        upgraded.try_serialize(&mut cursor)?;
        return Ok(());
    }
    if data.len() == v1_size {
        let legacy = MinerPositionV1 {
            owner: position.owner,
            hp: position.hp,
            start_ts: position.start_ts,
            end_ts: position.end_ts,
            reward_debt: position.reward_debt,
            final_acc_mind_per_hp: position.final_acc_mind_per_hp,
            deactivated: position.deactivated,
            bump: position.bump,
        };
        data[..8].copy_from_slice(&MinerPosition::DISCRIMINATOR);
        let mut cursor: &mut [u8] = &mut data[8..];
        legacy
            .serialize(&mut cursor)
            .map_err(|_| ErrorCode::InvalidPositionSize.into())
    } else {
        Err(ErrorCode::InvalidPositionSize.into())
    }
}

fn ensure_position_v2<'info>(
    info: &AccountInfo<'info>,
    payer: &AccountInfo<'info>,
    system_program: &Program<'info, System>,
) -> Result<()> {
    let new_size = 8 + MinerPosition::INIT_SPACE;
    if info.data_len() >= new_size {
        return Ok(());
    }
    require!(info.owner == &crate::ID, ErrorCode::InvalidPositionOwner);
    let needed = Rent::get()?.minimum_balance(new_size);
    let current = info.lamports();
    if needed > current {
        let diff = needed
            .checked_sub(current)
            .ok_or(ErrorCode::MathOverflow)?;
        system_program::transfer(
            CpiContext::new(
                system_program.to_account_info(),
                SystemTransfer {
                    from: payer.clone(),
                    to: info.clone(),
                },
            ),
            diff,
        )?;
    }
    info.realloc(new_size, true)?;
    Ok(())
}

fn ensure_user_profile_v2<'info>(
    info: &AccountInfo<'info>,
    payer: &AccountInfo<'info>,
    system_program: &Program<'info, System>,
    owner: Pubkey,
    bump: u8,
    now: i64,
) -> Result<UserMiningProfile> {
    let new_size = 8 + UserMiningProfile::INIT_SPACE;
    if info.owner == &system_program::ID && info.data_len() == 0 {
        let lamports = Rent::get()?.minimum_balance(new_size);
        let create_ix = solana_program::system_instruction::create_account(
            payer.key,
            info.key,
            lamports,
            new_size as u64,
            &crate::ID,
        );
        let seeds: &[&[u8]] = &[PROFILE_SEED, owner.as_ref(), &[bump]];
        solana_program::program::invoke_signed(
            &create_ix,
            &[payer.clone(), info.clone(), system_program.to_account_info()],
            &[seeds],
        )?;
        let profile = UserMiningProfile {
            owner,
            next_position_index: 0,
            active_hp: 0,
            xp: 0,
            badge_tier: 0,
            badge_bonus_bps: 0,
            bump,
            level: 1,
            last_xp_update_ts: now,
            hp_scaled: true,
        };
        save_user_profile(info, &profile)?;
        return Ok(profile);
    }
    require!(
        info.owner == &crate::ID,
        ErrorCode::InvalidUserProfileOwner
    );
    if info.data_len() < new_size {
        let needed = Rent::get()?.minimum_balance(new_size);
        let current = info.lamports();
        if needed > current {
            let diff = needed
                .checked_sub(current)
                .ok_or(ErrorCode::MathOverflow)?;
            system_program::transfer(
                CpiContext::new(
                    system_program.to_account_info(),
                    SystemTransfer {
                        from: payer.clone(),
                        to: info.clone(),
                    },
                ),
                diff,
            )?;
        }
        info.realloc(new_size, true)?;
    }
    let mut profile = load_user_profile_any(info)?;
    init_profile_defaults(&mut profile, owner, bump, now);
    ensure_profile_hp_scaled(&mut profile)?;
    save_user_profile(info, &profile)?;
    Ok(profile)
}

fn vault_available_lamports(vault: &Account<NativeVault>) -> Result<u64> {
    let rent = Rent::get()?.minimum_balance(8 + NativeVault::INIT_SPACE);
    Ok(vault.to_account_info().lamports().saturating_sub(rent))
}

fn transfer_lamports(from: &AccountInfo, to: &AccountInfo, amount: u64) -> Result<()> {
    let from_balance = **from.try_borrow_lamports()?;
    let to_balance = **to.try_borrow_lamports()?;
    **from.try_borrow_mut_lamports()? = from_balance
        .checked_sub(amount)
        .ok_or(ErrorCode::InsufficientVaultBalance)?;
    **to.try_borrow_mut_lamports()? = to_balance
        .checked_add(amount)
        .ok_or(ErrorCode::MathOverflow)?;
    Ok(())
}

fn contract_terms(contract_type: u8) -> Result<(u64, u64, u64)> {
    let base = XNT_BASE;
    match contract_type {
        0 => Ok((7, 60, base)),
        1 => Ok((14, 700, base.checked_mul(8).ok_or(ErrorCode::MathOverflow)?)),
        2 => Ok((28, 1_500, base.checked_mul(16).ok_or(ErrorCode::MathOverflow)?)),
        _ => Err(error!(ErrorCode::InvalidContractType)),
    }
}

fn earned_per_hp(hp: u128, acc_mind_per_hp: u128) -> Result<u128> {
    hp.checked_mul(acc_mind_per_hp)
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

fn grace_deadline_ts(end_ts: i64, seconds_per_day: u64) -> Result<i64> {
    let grace = (seconds_per_day as i64)
        .checked_mul(2)
        .ok_or(ErrorCode::MathOverflow)?;
    end_ts
        .checked_add(grace)
        .ok_or(ErrorCode::MathOverflow.into())
}

fn expire_position(
    cfg: &mut Account<Config>,
    position: &mut PositionData,
    user_profile: &mut UserMiningProfile,
    now: i64,
) -> Result<()> {
    if position.deactivated || position.expired || now < position.end_ts {
        return Ok(());
    }
    if cfg.last_update_ts < position.end_ts {
        update_mining_global(cfg, position.end_ts)?;
    }
    let rig_type = position_rig_type(position, cfg)?;
    let base_hp_scaled = position_base_hp_scaled(position)?;
    let buff_bps = position_buff_bps(position, rig_type, now);
    let hp_effective = effective_hp_scaled(base_hp_scaled, user_profile.level, buff_bps)?;
    let hp_effective_u64 = u64::try_from(hp_effective).map_err(|_| ErrorCode::MathOverflow)?;
    position.final_acc_mind_per_hp = cfg.acc_mind_per_hp;
    position.expired = true;
    cfg.network_hp_active = cfg
        .network_hp_active
        .checked_sub(hp_effective_u64)
        .ok_or(ErrorCode::MathOverflow)?;
    let base_hp_scaled_u64 = u64::try_from(base_hp_scaled).map_err(|_| ErrorCode::MathOverflow)?;
    user_profile.active_hp = user_profile
        .active_hp
        .checked_sub(base_hp_scaled_u64)
        .ok_or(ErrorCode::MathOverflow)?;
    update_mining_global(cfg, now)?;
    Ok(())
}

fn finalize_position(
    cfg: &mut Account<Config>,
    position: &mut PositionData,
    user_profile: &mut UserMiningProfile,
    now: i64,
) -> Result<()> {
    if !position.expired && cfg.last_update_ts < position.end_ts {
        update_mining_global(cfg, position.end_ts)?;
    }
    let rig_type = position_rig_type(position, cfg)?;
    let base_hp_scaled = position_base_hp_scaled(position)?;
    let buff_bps = position_buff_bps(position, rig_type, now);
    let hp_effective = effective_hp_scaled(base_hp_scaled, user_profile.level, buff_bps)?;
    let hp_effective_u64 = u64::try_from(hp_effective).map_err(|_| ErrorCode::MathOverflow)?;
    if !position.expired {
        position.final_acc_mind_per_hp = cfg.acc_mind_per_hp;
        cfg.network_hp_active = cfg
            .network_hp_active
            .checked_sub(hp_effective_u64)
            .ok_or(ErrorCode::MathOverflow)?;
        let base_hp_scaled_u64 =
            u64::try_from(base_hp_scaled).map_err(|_| ErrorCode::MathOverflow)?;
        user_profile.active_hp = user_profile
            .active_hp
            .checked_sub(base_hp_scaled_u64)
            .ok_or(ErrorCode::MathOverflow)?;
        position.expired = true;
    }
    position.deactivated = true;
    if hp_effective_u64 >= HP_SCALED_MARKER {
        return Err(ErrorCode::MathOverflow.into());
    }
    position.hp = hp_effective_u64 | HP_SCALED_MARKER;
    update_mining_global(cfg, now)?;
    Ok(())
}

fn pending_mind(hp_effective: u128, acc_mind_per_hp: u128, reward_debt: u128) -> Result<u128> {
    let earned = earned_per_hp(hp_effective, acc_mind_per_hp)?;
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
    #[msg("Invalid mint")]
    InvalidMint,
    #[msg("Invalid user profile owner")]
    InvalidUserProfileOwner,
    #[msg("Invalid user profile discriminator")]
    InvalidUserProfileDiscriminator,
    #[msg("Invalid user profile size")]
    InvalidUserProfileSize,
    #[msg("Max level reached")]
    MaxLevelReached,
    #[msg("Insufficient XP")]
    InsufficientXp,
    #[msg("Insufficient MIND for level up")]
    InsufficientLevelUpFunds,
    #[msg("HP scaling already enabled")]
    HpScaleAlreadyEnabled,
    #[msg("Invalid level")]
    InvalidLevel,
    #[msg("Invalid level up positions")]
    InvalidLevelUpPositions,
    #[msg("Invalid position owner")]
    InvalidPositionOwner,
    #[msg("Invalid position discriminator")]
    InvalidPositionDiscriminator,
    #[msg("Invalid position size")]
    InvalidPositionSize,
    #[msg("Invalid rig duration")]
    InvalidRigDuration,
    #[msg("Position still in grace period")]
    PositionInGrace,
    #[msg("Position grace period expired")]
    PositionGraceExpired,
    #[msg("Rig buff cap exceeded")]
    RigBuffCapExceeded,
    #[msg("Insufficient MIND for rig buff")]
    InsufficientBuffFunds,
    #[msg("Invalid rig buff positions")]
    InvalidRigBuffPositions,
}
