use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hashv;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::system_program::{self, Transfer as SystemTransfer};
use anchor_spl::associated_token::{get_associated_token_address, AssociatedToken};
use anchor_spl::token::{
    self, Burn, Mint, MintTo, SetAuthority, SyncNative, Token, TokenAccount, Transfer as SplTransfer,
};
use solana_program::bpf_loader_upgradeable::{self, UpgradeableLoaderState};

declare_id!("AGAdJKoLhrGrdFwrZZDEWsoR1Tq8kMcXGRKxX2wa2jfm");

// ── Constants ────────────────────────────────────────────────────────────────

/// XNT/USDC pool on xdex — same oracle pair used by swap_router's refresh_price.
/// token_0_vault = XNT (9 decimals), token_1_vault = USDC (6 decimals)
const XNT_USDC_XNT_VAULT: Pubkey =
    solana_program::pubkey!("8wvV4HKBDFMLEUkVWp1WPNa5ano99XCm3f9t3troyLb");
const XNT_USDC_USDC_VAULT: Pubkey =
    solana_program::pubkey!("7iw2adw8Af7x3pY7gj5RwczFXuGjCoX92Gfy3avwXQtg");

const GLOBAL_CONFIG_SEED: &[u8] = b"launchpad_config";
const TREASURY_VAULT_SEED: &[u8] = b"launchpad_treasury";
const CURVE_SEED: &[u8] = b"curve";
const CURVE_XNT_VAULT_SEED: &[u8] = b"curve_xnt_vault";
const REWARD_POOL_XNT_SEED: &[u8] = b"reward_pool_xnt";
const REWARD_POOL_TOKEN_SEED: &[u8] = b"reward_pool_token";
const CURVE_TOKEN_VAULT_SEED: &[u8] = b"curve_token_vault";
const GRAD_RESERVE_SEED: &[u8] = b"grad_reserve";

const BPS_DENOM: u128 = 10_000;
const DEFAULT_FEE_BPS: u16 = 100; // 1.0% total (0.5% treasury + 0.5% reward pool)
const DEFAULT_GIGA_MIN_USD_CENTS: u64 = 500; // $5.00
const GIGA_BASE_DENOM: u64 = 100;

const TOKEN_DECIMALS: u8 = 6;
const DECIMALS_MULTIPLIER: u64 = 1_000_000; // 10^6
const XNT_BASE: u64 = 1_000_000_000; // XNT/SOL lamports, 9 decimals

/// Total supply of every launchpad token: 1,000,000,000 tokens (raw units below).
const CURVE_ALLOCATION: u64 = 800_000_000 * DECIMALS_MULTIPLIER; // 80% — sellable on the curve
const REWARD_POOL_TOKEN_ALLOCATION: u64 = 100_000_000 * DECIMALS_MULTIPLIER; // 10% — GigaSwap jackpot seed
const GRAD_RESERVE_ALLOCATION: u64 = 50_000_000 * DECIMALS_MULTIPLIER; // 5% — reserved for v2 graduation, untouched in v1
const CREATOR_ALLOCATION: u64 = 50_000_000 * DECIMALS_MULTIPLIER; // 5% — immediate, unlocked (known v1 tradeoff)

/// Below this many raw token units left on the curve, graduation is allowed even though the
/// curve isn't at literal zero. Discovered via local testing: the constant-product formula's
/// u64 integer division means the last fraction of a token (a few hundred raw units — a small
/// multiple of k/virtual_xnt^2, the curve's local granularity near full sellout) is often
/// mathematically unbuyable at any lamport amount, so requiring exactly 0 would make
/// `graduate()` practically uncallable. 1,000 raw units = 0.001 of a token — worth a small
/// fraction of a cent even at the curve's full-sellout price, and it just sits inert in
/// `curve_token_vault` forever after graduation.
const GRADUATION_DUST_THRESHOLD: u64 = 1_000;

/// Virtual reserves determine the starting price curve (pump.fun-style constant product).
/// NOTE: these are purely virtual accounting numbers used by the pricing formula — nobody
/// deposits this XNT anywhere at token creation, it only shapes how fast price moves per
/// trade. X1 is a much smaller/thinner-liquidity chain than Solana, so this curve targets a
/// much lower ceiling than a typical pump.fun launch: ~$93 starting FDV, ~$1,440 FDV once the
/// curve fully sells out (at $0.50/XNT), raising ~586 XNT (~$293) total into the curve.
const INITIAL_VIRTUAL_TOKEN_RESERVES: u64 = 1_073_000_000 * DECIMALS_MULTIPLIER;
const INITIAL_VIRTUAL_XNT_RESERVES: u64 = 200 * XNT_BASE; // 200 XNT

/// xdex = the xdex AMM on X1, confirmed during Faza 1 research to be an unmodified fork of
/// Raydium CP-Swap (byte-for-byte identical `initialize` discriminator, args, account order
/// and every PDA seed, verified against the real transaction that created the MIND/XNT pool).
/// No published crate/IDL exists for it, so `graduate()` below builds and signs the CPI by
/// hand instead of depending on one.
const XDEX_PROGRAM_ID: Pubkey = solana_program::pubkey!("sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN");
const XDEX_AMM_CONFIG: Pubkey = solana_program::pubkey!("2eFPWosizV6nSAGeSvi5tRgXLoqhjnSesra23ALA248c");
/// Confirmed against the live xdex program's own enforced constraint (not just the address seen
/// in one historical pool-creation tx, which turned out to be per-amm_config, not global) —
/// caught by a real `ConstraintAddress` revert during local testing.
const XDEX_CREATE_POOL_FEE_RECEIVER: Pubkey =
    solana_program::pubkey!("SKc6b6zAv2kkB9EtitjppbzPVR48bCMfRtE5B8KDuF1");
const WXNT_MINT: Pubkey = solana_program::pubkey!("So11111111111111111111111111111111111111112");

const XDEX_CREATOR_SEED: &[u8] = b"xdex_creator";
const XDEX_AUTHORITY_SEED: &[u8] = b"vault_and_lp_mint_auth_seed";
const XDEX_POOL_SEED: &[u8] = b"pool";
const XDEX_POOL_LP_MINT_SEED: &[u8] = b"pool_lp_mint";
const XDEX_POOL_VAULT_SEED: &[u8] = b"pool_vault";
const XDEX_OBSERVATION_SEED: &[u8] = b"observation";

/// sha256("global:initialize")[..8] — confirmed byte-for-byte against a real xdex pool-creation
/// transaction (Anchor's standard global-instruction discriminator scheme, unmodified by xdex).
const XDEX_INITIALIZE_DISCRIMINATOR: [u8; 8] = [0xaf, 0xaf, 0x6d, 0x1f, 0x0d, 0x98, 0x9b, 0xed];

/// Lamports transferred into `xdex_creator` right before the graduation CPI so it can afford to
/// be xdex's rent payer for the five brand-new accounts `initialize` creates (pool_state,
/// lp_mint, 2 vaults, observation_state) plus the curve's own LP ATA, *and* xdex's own fixed
/// pool-creation fee (confirmed via local testing to be 0.1 XNT, on top of rent — the account
/// rents alone run ~0.042 XNT, so 0.1 XNT total wasn't enough). Deliberately generous — any
/// leftover just sits in `xdex_creator`, a dedicated PDA with no other purpose.
const GRADUATION_RENT_BUFFER_LAMPORTS: u64 = 250_000_000; // 0.25 XNT

// ── Program ──────────────────────────────────────────────────────────────────

#[program]
pub mod launchpad {
    use super::*;

    /// One-time setup. Caller must be the program's upgrade authority (mirrors mining_v2's
    /// init_config pattern) — whoever holds upgrade authority at deploy time becomes admin.
    pub fn init_global_config(
        ctx: Context<InitGlobalConfig>,
        admin: Pubkey,
        xnt_usd_cents: u64,
        token_creation_fee_lamports: u64,
    ) -> Result<()> {
        assert_upgrade_authority(&ctx.accounts.program_data, ctx.accounts.payer.key())?;
        let cfg = &mut ctx.accounts.config;
        cfg.admin = admin;
        cfg.xnt_usd_cents = xnt_usd_cents;
        cfg.fee_bps = DEFAULT_FEE_BPS;
        cfg.giga_min_usd_cents = DEFAULT_GIGA_MIN_USD_CENTS;
        cfg.token_creation_fee_lamports = token_creation_fee_lamports;
        cfg.total_tokens_created = 0;
        cfg.total_volume_xnt = 0;
        cfg.bump = *ctx.bumps.get("config").unwrap();
        cfg.treasury_vault_bump = *ctx.bumps.get("treasury_vault").unwrap();
        emit!(GlobalConfigInitialized {
            admin,
            xnt_usd_cents,
        });
        Ok(())
    }

    /// Admin override of the cached XNT/USD price.
    pub fn update_price(ctx: Context<UpdatePrice>, xnt_usd_cents: u64) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.config.admin,
            ctx.accounts.admin.key(),
            LaunchpadError::Unauthorized
        );
        ctx.accounts.config.xnt_usd_cents = xnt_usd_cents;
        Ok(())
    }

    /// Permissionless: refresh the cached XNT/USD price from the same xdex XNT/USDC pool
    /// vaults swap_router uses. Raw SPL token `amount` field lives at byte offset 64.
    pub fn refresh_price(ctx: Context<RefreshPrice>) -> Result<()> {
        let xnt_raw = read_account_amount(&ctx.accounts.xnt_vault)?;
        let usdc_raw = read_account_amount(&ctx.accounts.usdc_vault)?;
        require!(xnt_raw > 0, LaunchpadError::MathOverflow);
        // USDC has 6 decimals, XNT has 9 decimals -> cents = usdc_raw * 100_000 / xnt_raw
        let cents = (usdc_raw as u128)
            .checked_mul(100_000)
            .ok_or(LaunchpadError::MathOverflow)?
            .checked_div(xnt_raw as u128)
            .ok_or(LaunchpadError::MathOverflow)?;
        ctx.accounts.config.xnt_usd_cents = cents as u64;
        Ok(())
    }

    /// Permissionless "create your own token" — step 1 of 4. Split into four instructions
    /// (create_mint -> init_curve -> init_token_vaults -> finalize_token), all sent as one
    /// client-side transaction so creation stays atomic. This split exists purely because of
    /// a Solana BPF platform limit: a single instruction touching all ~8 accounts this flow
    /// needs to `init` blows the 4KB BPF stack frame even after boxing every account (see
    /// commit history / plan notes) — splitting is the standard fix, not a design choice.
    ///
    /// Step 1: create the fixed-supply SPL mint and the creator's ATA, mint the creator's 5%
    /// allocation. Mint authority stays `creator` (a plain signer) until `finalize_token`
    /// revokes it. Token metadata (name/symbol/uri) on Metaplex is set by a separate
    /// client-side instruction in the same transaction, mirroring scripts/set-metadata.ts —
    /// this program never CPIs into Metaplex itself.
    pub fn create_mint(
        ctx: Context<CreateMint>,
        name: String,
        symbol: String,
        uri: String,
    ) -> Result<()> {
        require!(name.len() <= 32, LaunchpadError::NameTooLong);
        require!(symbol.len() <= 10, LaunchpadError::SymbolTooLong);
        require!(uri.len() <= 200, LaunchpadError::UriTooLong);

        let fee = ctx.accounts.config.token_creation_fee_lamports;
        if fee > 0 {
            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    SystemTransfer {
                        from: ctx.accounts.creator.to_account_info(),
                        to: ctx.accounts.treasury_vault.to_account_info(),
                    },
                ),
                fee,
            )?;
        }

        token::mint_to(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.creator_token_account.to_account_info(),
                    authority: ctx.accounts.creator.to_account_info(),
                },
            ),
            CREATOR_ALLOCATION,
        )?;

        emit!(LaunchpadMintCreated {
            mint: ctx.accounts.mint.key(),
            creator: ctx.accounts.creator.key(),
            name,
            symbol,
            uri,
        });
        Ok(())
    }

    /// Step 2 of 4: spin up the bonding curve state account plus its two native-XNT vaults
    /// (curve reserve + reward pool). Token-vault bump fields are left at 0 here and filled
    /// in by `init_token_vaults`; `real_token_reserves`/`reward_pool_token_balance` stay 0
    /// until `finalize_token` actually mints into those vaults.
    pub fn init_curve(ctx: Context<InitCurve>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let curve = &mut ctx.accounts.curve;
        curve.mint = ctx.accounts.mint.key();
        curve.creator = ctx.accounts.creator.key();
        curve.virtual_token_reserves = INITIAL_VIRTUAL_TOKEN_RESERVES;
        curve.virtual_xnt_reserves = INITIAL_VIRTUAL_XNT_RESERVES;
        curve.real_token_reserves = 0;
        curve.real_xnt_reserves = 0;
        curve.reward_pool_xnt_balance = 0;
        curve.reward_pool_token_balance = 0;
        curve.trade_counter = 0;
        curve.giga_hits = 0;
        curve.complete = false;
        curve.created_at = now;
        curve.bump = *ctx.bumps.get("curve").unwrap();
        curve.curve_xnt_vault_bump = *ctx.bumps.get("curve_xnt_vault").unwrap();
        curve.reward_pool_xnt_vault_bump = *ctx.bumps.get("reward_pool_xnt_vault").unwrap();
        curve.reward_pool_token_vault_bump = 0;
        curve.curve_token_vault_bump = 0;
        curve.grad_reserve_vault_bump = 0;
        Ok(())
    }

    /// Step 3 of 4 (split into three single-vault instructions — even a single SPL
    /// `token::init` custom-seeded account CPI is expensive enough in generated stack space
    /// that three of them together still overflowed the 4KB BPF limit). No minting happens
    /// here, just account creation.
    pub fn init_curve_token_vault(ctx: Context<InitCurveTokenVault>) -> Result<()> {
        ctx.accounts.curve.curve_token_vault_bump = *ctx.bumps.get("curve_token_vault").unwrap();
        Ok(())
    }

    pub fn init_reward_pool_token_vault(ctx: Context<InitRewardPoolTokenVault>) -> Result<()> {
        ctx.accounts.curve.reward_pool_token_vault_bump =
            *ctx.bumps.get("reward_pool_token_vault").unwrap();
        Ok(())
    }

    pub fn init_grad_reserve_vault(ctx: Context<InitGradReserveVault>) -> Result<()> {
        ctx.accounts.curve.grad_reserve_vault_bump = *ctx.bumps.get("grad_reserve_vault").unwrap();
        Ok(())
    }

    /// Step 4 of 4: mint the curve/reward-pool/graduation-reserve allocations (80/10/5%),
    /// revoke the mint authority forever (fixed supply from here on), record the final
    /// curve balances, optionally accept the creator's extra XNT reward-pool seed, and emit
    /// the event the scanner keys off of to know a token finished creation successfully.
    pub fn finalize_token(
        ctx: Context<FinalizeToken>,
        initial_reward_pool_xnt: u64,
    ) -> Result<()> {
        token::mint_to(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.curve_token_vault.to_account_info(),
                    authority: ctx.accounts.creator.to_account_info(),
                },
            ),
            CURVE_ALLOCATION,
        )?;
        token::mint_to(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.reward_pool_token_vault.to_account_info(),
                    authority: ctx.accounts.creator.to_account_info(),
                },
            ),
            REWARD_POOL_TOKEN_ALLOCATION,
        )?;
        token::mint_to(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.grad_reserve_vault.to_account_info(),
                    authority: ctx.accounts.creator.to_account_info(),
                },
            ),
            GRAD_RESERVE_ALLOCATION,
        )?;

        // Fixed supply forever: revoke mint authority.
        token::set_authority(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                SetAuthority {
                    current_authority: ctx.accounts.creator.to_account_info(),
                    account_or_mint: ctx.accounts.mint.to_account_info(),
                },
            ),
            anchor_spl::token::spl_token::instruction::AuthorityType::MintTokens,
            None,
        )?;

        let curve = &mut ctx.accounts.curve;
        curve.real_token_reserves = CURVE_ALLOCATION;
        curve.reward_pool_token_balance = REWARD_POOL_TOKEN_ALLOCATION;

        if initial_reward_pool_xnt > 0 {
            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    SystemTransfer {
                        from: ctx.accounts.creator.to_account_info(),
                        to: ctx.accounts.reward_pool_xnt_vault.to_account_info(),
                    },
                ),
                initial_reward_pool_xnt,
            )?;
            curve.reward_pool_xnt_balance = curve
                .reward_pool_xnt_balance
                .checked_add(initial_reward_pool_xnt)
                .ok_or(LaunchpadError::MathOverflow)?;
        }

        ctx.accounts.config.total_tokens_created = ctx
            .accounts
            .config
            .total_tokens_created
            .checked_add(1)
            .ok_or(LaunchpadError::MathOverflow)?;

        emit!(LaunchpadTokenCreated {
            mint: curve.mint,
            creator: curve.creator,
            curve: curve.key(),
            created_at: curve.created_at,
        });
        Ok(())
    }

    /// Buy tokens off the bonding curve with XNT.
    pub fn buy(ctx: Context<Trade>, xnt_in: u64, min_tokens_out: u64) -> Result<()> {
        require!(xnt_in > 0, LaunchpadError::ZeroAmount);
        require!(!ctx.accounts.curve.complete, LaunchpadError::CurveComplete);

        let fee_bps = ctx.accounts.config.fee_bps as u128;
        let fee_total = ((xnt_in as u128)
            .checked_mul(fee_bps)
            .ok_or(LaunchpadError::MathOverflow)?
            / BPS_DENOM) as u64;
        let treasury_fee = fee_total / 2;
        let pool_fee = fee_total - treasury_fee;
        let xnt_to_curve = xnt_in
            .checked_sub(fee_total)
            .ok_or(LaunchpadError::MathOverflow)?;

        let (new_virtual_xnt, new_virtual_token, tokens_out) = {
            let curve = &ctx.accounts.curve;
            let k = (curve.virtual_token_reserves as u128)
                .checked_mul(curve.virtual_xnt_reserves as u128)
                .ok_or(LaunchpadError::MathOverflow)?;
            let new_virtual_xnt = curve
                .virtual_xnt_reserves
                .checked_add(xnt_to_curve)
                .ok_or(LaunchpadError::MathOverflow)?;
            let new_virtual_token = (k / (new_virtual_xnt as u128)) as u64;
            let tokens_out = curve
                .virtual_token_reserves
                .checked_sub(new_virtual_token)
                .ok_or(LaunchpadError::MathOverflow)?;
            (new_virtual_xnt, new_virtual_token, tokens_out)
        };
        require!(
            tokens_out <= ctx.accounts.curve.real_token_reserves,
            LaunchpadError::SoldOut
        );
        require!(
            tokens_out >= min_tokens_out,
            LaunchpadError::SlippageExceeded
        );

        // Move XNT: fee splits to treasury + reward pool, remainder into the curve vault.
        if treasury_fee > 0 {
            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    SystemTransfer {
                        from: ctx.accounts.user.to_account_info(),
                        to: ctx.accounts.treasury_vault.to_account_info(),
                    },
                ),
                treasury_fee,
            )?;
        }
        if pool_fee > 0 {
            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    SystemTransfer {
                        from: ctx.accounts.user.to_account_info(),
                        to: ctx.accounts.reward_pool_xnt_vault.to_account_info(),
                    },
                ),
                pool_fee,
            )?;
        }
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                SystemTransfer {
                    from: ctx.accounts.user.to_account_info(),
                    to: ctx.accounts.curve_xnt_vault.to_account_info(),
                },
            ),
            xnt_to_curve,
        )?;

        // Pay out tokens from the curve vault, signed by the curve PDA.
        let mint_key = ctx.accounts.mint.key();
        let curve_bump = ctx.accounts.curve.bump;
        let curve_seeds: &[&[u8]] = &[CURVE_SEED, mint_key.as_ref(), &[curve_bump]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                SplTransfer {
                    from: ctx.accounts.curve_token_vault.to_account_info(),
                    to: ctx.accounts.user_token_account.to_account_info(),
                    authority: ctx.accounts.curve.to_account_info(),
                },
                &[curve_seeds],
            ),
            tokens_out,
        )?;

        let xnt_usd_cents = ctx.accounts.config.xnt_usd_cents;
        {
            let curve = &mut ctx.accounts.curve;
            curve.virtual_xnt_reserves = new_virtual_xnt;
            curve.virtual_token_reserves = new_virtual_token;
            curve.real_xnt_reserves = curve
                .real_xnt_reserves
                .checked_add(xnt_to_curve)
                .ok_or(LaunchpadError::MathOverflow)?;
            curve.real_token_reserves = curve
                .real_token_reserves
                .checked_sub(tokens_out)
                .ok_or(LaunchpadError::MathOverflow)?;
            curve.reward_pool_xnt_balance = curve
                .reward_pool_xnt_balance
                .checked_add(pool_fee)
                .ok_or(LaunchpadError::MathOverflow)?;
        }
        ctx.accounts.config.total_volume_xnt = ctx
            .accounts
            .config
            .total_volume_xnt
            .checked_add(xnt_in as u128)
            .ok_or(LaunchpadError::MathOverflow)?;

        let giga = try_giga_swap(
            &mut ctx.accounts.curve,
            &ctx.accounts.reward_pool_xnt_vault.to_account_info(),
            &ctx.accounts.reward_pool_token_vault,
            &ctx.accounts.user_token_account,
            &ctx.accounts.token_program.to_account_info(),
            &ctx.accounts.user.to_account_info(),
            xnt_to_curve,
            xnt_usd_cents,
            curve_seeds,
        )?;

        emit!(LaunchpadTradeEvent {
            user: ctx.accounts.user.key(),
            mint: mint_key,
            is_buy: true,
            xnt_amount: xnt_in,
            token_amount: tokens_out,
            fee_total,
        });
        if giga.payout > 0 {
            emit!(LaunchpadGigaEvent {
                user: ctx.accounts.user.key(),
                trade_counter: ctx.accounts.curve.trade_counter,
                usd_cents: giga.usd_cents,
                tier_bps: giga.tier_bps,
                payout: giga.payout,
                paid_in_token: giga.paid_in_token,
                mint: mint_key,
            });
        }
        Ok(())
    }

    /// Sell tokens back into the bonding curve for XNT.
    pub fn sell(ctx: Context<Trade>, token_in: u64, min_xnt_out: u64) -> Result<()> {
        require!(token_in > 0, LaunchpadError::ZeroAmount);
        require!(!ctx.accounts.curve.complete, LaunchpadError::CurveComplete);

        let (new_virtual_token, new_virtual_xnt, gross_xnt_out) = {
            let curve = &ctx.accounts.curve;
            let k = (curve.virtual_token_reserves as u128)
                .checked_mul(curve.virtual_xnt_reserves as u128)
                .ok_or(LaunchpadError::MathOverflow)?;
            let new_virtual_token = curve
                .virtual_token_reserves
                .checked_add(token_in)
                .ok_or(LaunchpadError::MathOverflow)?;
            let new_virtual_xnt = (k / (new_virtual_token as u128)) as u64;
            let gross_xnt_out = curve
                .virtual_xnt_reserves
                .checked_sub(new_virtual_xnt)
                .ok_or(LaunchpadError::MathOverflow)?;
            (new_virtual_token, new_virtual_xnt, gross_xnt_out)
        };
        require!(
            gross_xnt_out <= ctx.accounts.curve.real_xnt_reserves,
            LaunchpadError::InsufficientLiquidity
        );

        let fee_bps = ctx.accounts.config.fee_bps as u128;
        let fee_total = ((gross_xnt_out as u128)
            .checked_mul(fee_bps)
            .ok_or(LaunchpadError::MathOverflow)?
            / BPS_DENOM) as u64;
        let treasury_fee = fee_total / 2;
        let pool_fee = fee_total - treasury_fee;
        let net_xnt_out = gross_xnt_out
            .checked_sub(fee_total)
            .ok_or(LaunchpadError::MathOverflow)?;
        require!(net_xnt_out >= min_xnt_out, LaunchpadError::SlippageExceeded);

        // Pull tokens from the seller into the curve vault first.
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                SplTransfer {
                    from: ctx.accounts.user_token_account.to_account_info(),
                    to: ctx.accounts.curve_token_vault.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            token_in,
        )?;

        // Pay XNT out of the curve vault: net to user, fee split to treasury + reward pool.
        // curve_xnt_vault is program-owned (NativeVault), so direct lamport debit is legal.
        transfer_lamports(
            &ctx.accounts.curve_xnt_vault.to_account_info(),
            &ctx.accounts.user.to_account_info(),
            net_xnt_out,
        )?;
        if treasury_fee > 0 {
            transfer_lamports(
                &ctx.accounts.curve_xnt_vault.to_account_info(),
                &ctx.accounts.treasury_vault.to_account_info(),
                treasury_fee,
            )?;
        }
        if pool_fee > 0 {
            transfer_lamports(
                &ctx.accounts.curve_xnt_vault.to_account_info(),
                &ctx.accounts.reward_pool_xnt_vault.to_account_info(),
                pool_fee,
            )?;
        }

        let xnt_usd_cents = ctx.accounts.config.xnt_usd_cents;
        let mint_key = ctx.accounts.mint.key();
        let curve_bump = ctx.accounts.curve.bump;
        let curve_seeds: &[&[u8]] = &[CURVE_SEED, mint_key.as_ref(), &[curve_bump]];
        {
            let curve = &mut ctx.accounts.curve;
            curve.virtual_token_reserves = new_virtual_token;
            curve.virtual_xnt_reserves = new_virtual_xnt;
            curve.real_token_reserves = curve
                .real_token_reserves
                .checked_add(token_in)
                .ok_or(LaunchpadError::MathOverflow)?;
            curve.real_xnt_reserves = curve
                .real_xnt_reserves
                .checked_sub(gross_xnt_out)
                .ok_or(LaunchpadError::MathOverflow)?;
            curve.reward_pool_xnt_balance = curve
                .reward_pool_xnt_balance
                .checked_add(pool_fee)
                .ok_or(LaunchpadError::MathOverflow)?;
        }
        ctx.accounts.config.total_volume_xnt = ctx
            .accounts
            .config
            .total_volume_xnt
            .checked_add(gross_xnt_out as u128)
            .ok_or(LaunchpadError::MathOverflow)?;

        let giga = try_giga_swap(
            &mut ctx.accounts.curve,
            &ctx.accounts.reward_pool_xnt_vault.to_account_info(),
            &ctx.accounts.reward_pool_token_vault,
            &ctx.accounts.user_token_account,
            &ctx.accounts.token_program.to_account_info(),
            &ctx.accounts.user.to_account_info(),
            gross_xnt_out,
            xnt_usd_cents,
            curve_seeds,
        )?;

        emit!(LaunchpadTradeEvent {
            user: ctx.accounts.user.key(),
            mint: mint_key,
            is_buy: false,
            xnt_amount: net_xnt_out,
            token_amount: token_in,
            fee_total,
        });
        if giga.payout > 0 {
            emit!(LaunchpadGigaEvent {
                user: ctx.accounts.user.key(),
                trade_counter: ctx.accounts.curve.trade_counter,
                usd_cents: giga.usd_cents,
                tier_bps: giga.tier_bps,
                payout: giga.payout,
                paid_in_token: giga.paid_in_token,
                mint: mint_key,
            });
        }
        Ok(())
    }

    /// Permissionless: anyone can top up a token's XNT reward pool.
    pub fn deposit_reward_pool(ctx: Context<DepositRewardPool>, amount: u64) -> Result<()> {
        require!(amount > 0, LaunchpadError::ZeroAmount);
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                SystemTransfer {
                    from: ctx.accounts.depositor.to_account_info(),
                    to: ctx.accounts.reward_pool_xnt_vault.to_account_info(),
                },
            ),
            amount,
        )?;
        ctx.accounts.curve.reward_pool_xnt_balance = ctx
            .accounts
            .curve
            .reward_pool_xnt_balance
            .checked_add(amount)
            .ok_or(LaunchpadError::MathOverflow)?;
        Ok(())
    }

    /// Admin-only: withdraw from the *global* treasury vault. There is deliberately no
    /// equivalent withdraw for any per-token reward pool (token or XNT side) — the only way
    /// out of a reward pool is a GigaSwap win.
    pub fn admin_withdraw_treasury(ctx: Context<AdminWithdrawTreasury>, amount: u64) -> Result<()> {
        require!(amount > 0, LaunchpadError::ZeroAmount);
        let available = vault_available_lamports(&ctx.accounts.treasury_vault)?;
        require!(available >= amount, LaunchpadError::InsufficientVaultBalance);
        transfer_lamports(
            &ctx.accounts.treasury_vault.to_account_info(),
            &ctx.accounts.admin.to_account_info(),
            amount,
        )?;
        Ok(())
    }

    /// Permissionless: once a curve is (almost) fully sold out — `real_token_reserves` at or
    /// below `GRADUATION_DUST_THRESHOLD` — it can no longer serve buys or sells, the exact
    /// stuck-token failure mode this instruction exists to close. Anyone may call it to migrate
    /// the curve's real XNT + the reserved 5% graduation allocation into a brand-new xdex pool,
    /// exactly like pump.fun's graduation to Raydium: wrap the real XNT into WXNT, CPI into
    /// xdex's `initialize`, then permanently burn the LP tokens the new pool mints back to us so
    /// nobody — including the admin — can ever pull that liquidity back out.
    ///
    /// Split into two instructions purely because of the same Solana BPF stack limit that split
    /// `create_token` — this many accounts (13 xdex PDAs/ATAs plus the curve's own) overflow the
    /// 4KB frame in a single `try_accounts` even after boxing. Step 1 (this fn): fund
    /// `xdex_creator`, wrap the curve's real XNT into WXNT, move the graduation-reserve tokens
    /// into a plain ATA. Step 2 (`graduate_finalize`): the actual xdex CPI + LP burn.
    pub fn graduate_prepare(ctx: Context<GraduatePrepare>) -> Result<()> {
        require!(!ctx.accounts.curve.complete, LaunchpadError::CurveComplete);
        require!(
            ctx.accounts.curve.real_token_reserves <= GRADUATION_DUST_THRESHOLD,
            LaunchpadError::CurveNotSoldOut
        );

        let mint_key = ctx.accounts.mint.key();
        let curve_bump = ctx.accounts.curve.bump;
        let curve_seeds: &[&[u8]] = &[CURVE_SEED, mint_key.as_ref(), &[curve_bump]];

        // xdex's `initialize` acts as both the signing authority AND the rent-payer for the
        // five new accounts it creates internally (pool_state, lp_mint, 2 vaults,
        // observation_state) plus our LP ATA — and it pays for them with plain System Program
        // transfers, which require the source to be a data-less account. `curve` itself can't
        // play that role (it's a data-carrying Anchor account), so `xdex_creator` is a second,
        // purely-a-signer PDA that only this instruction ever touches — top it up first.
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                SystemTransfer {
                    from: ctx.accounts.payer.to_account_info(),
                    to: ctx.accounts.xdex_creator.to_account_info(),
                },
            ),
            GRADUATION_RENT_BUFFER_LAMPORTS,
        )?;

        // xdex pools are plain SPL-token pairs with no native-SOL side — wrap the curve's real
        // XNT into WXNT exactly like a normal wallet would. curve_xnt_vault is program-owned so
        // a raw lamport debit is legal (same trick sell() uses). Discovered empirically: a raw
        // lamport credit must be the *last* thing that touches an account in a given top-level
        // instruction — following it with a CPI on that same account (even an unrelated one,
        // even in a different instruction call within the same fn) trips the runtime's lamport
        // conservation check. So the credit happens here, last, and `sync_native` (a CPI on this
        // same account) is deferred to graduate_finalize, a separate top-level instruction.
        let xnt_amount = ctx.accounts.curve.real_xnt_reserves;
        require!(xnt_amount > 0, LaunchpadError::InsufficientLiquidity);

        // Move the reserved 5% graduation allocation out of its custom-seeded vault into a
        // plain ATA owned by `xdex_creator` — xdex's initialize expects a canonical ATA, not
        // our program's custom-seeded token account. Done *before* the raw XNT credit below so
        // that credit can be this instruction's last touch on any account.
        let token_amount = ctx.accounts.grad_reserve_vault.amount;
        require!(token_amount > 0, LaunchpadError::InsufficientLiquidity);
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                SplTransfer {
                    from: ctx.accounts.grad_reserve_vault.to_account_info(),
                    to: ctx.accounts.curve_mint_ata.to_account_info(),
                    authority: ctx.accounts.curve.to_account_info(),
                },
                &[curve_seeds],
            ),
            token_amount,
        )?;

        transfer_lamports(
            &ctx.accounts.curve_xnt_vault.to_account_info(),
            &ctx.accounts.curve_wxnt_ata.to_account_info(),
            xnt_amount,
        )?;
        Ok(())
    }

    /// Step 2 of 2: the actual xdex pool-creation CPI plus the LP burn — reads the exact
    /// amounts `graduate_prepare` moved from `curve_wxnt_ata`/`curve_mint_ata` directly, so no
    /// extra state needs to survive between the two instructions beyond those two ATAs.
    pub fn graduate_finalize(ctx: Context<GraduateFinalize>) -> Result<()> {
        require!(!ctx.accounts.curve.complete, LaunchpadError::CurveComplete);

        let mint_key = ctx.accounts.mint.key();
        let xdex_creator_bump = *ctx.bumps.get("xdex_creator").unwrap();
        let xdex_creator_seeds: &[&[u8]] =
            &[XDEX_CREATOR_SEED, mint_key.as_ref(), &[xdex_creator_bump]];

        // graduate_prepare only credited curve_wxnt_ata's raw lamports (deliberately, as the
        // very last touch on that account in that instruction — see comment there); its SPL
        // `amount` field still reads 0 until sync_native runs, so do that first and reload.
        token::sync_native(CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            SyncNative {
                account: ctx.accounts.curve_wxnt_ata.to_account_info(),
            },
        ))?;
        ctx.accounts.curve_wxnt_ata.reload()?;

        let xnt_amount = ctx.accounts.curve_wxnt_ata.amount;
        let token_amount = ctx.accounts.curve_mint_ata.amount;
        require!(xnt_amount > 0, LaunchpadError::InsufficientLiquidity);
        require!(token_amount > 0, LaunchpadError::InsufficientLiquidity);

        // Raw CPI into xdex's `initialize` — no published crate/IDL to depend on, so the
        // instruction is built by hand. Account order, discriminator and every PDA seed below
        // were confirmed byte-for-byte against the real MIND/XNT pool-creation transaction
        // during Faza 1 research (see plan notes): creator, amm_config, authority, pool_state,
        // mint_0 (always WXNT), mint_1, lp_mint, creator_ata_0, creator_ata_1, creator_lp_ata,
        // vault_0, vault_1, create_pool_fee_receiver, observation_state, token_program x3,
        // associated_token_program, system_program, rent.
        let open_time = Clock::get()?.unix_timestamp as u64;
        let mut ix_data = XDEX_INITIALIZE_DISCRIMINATOR.to_vec();
        ix_data.extend_from_slice(&xnt_amount.to_le_bytes());
        ix_data.extend_from_slice(&token_amount.to_le_bytes());
        ix_data.extend_from_slice(&open_time.to_le_bytes());

        let account_metas = vec![
            AccountMeta::new(ctx.accounts.xdex_creator.key(), true),
            AccountMeta::new_readonly(ctx.accounts.xdex_amm_config.key(), false),
            AccountMeta::new_readonly(ctx.accounts.xdex_authority.key(), false),
            AccountMeta::new(ctx.accounts.xdex_pool_state.key(), false),
            AccountMeta::new_readonly(ctx.accounts.wxnt_mint.key(), false),
            AccountMeta::new_readonly(mint_key, false),
            AccountMeta::new(ctx.accounts.xdex_lp_mint.key(), false),
            AccountMeta::new(ctx.accounts.curve_wxnt_ata.key(), false),
            AccountMeta::new(ctx.accounts.curve_mint_ata.key(), false),
            AccountMeta::new(ctx.accounts.curve_lp_ata.key(), false),
            AccountMeta::new(ctx.accounts.xdex_vault_0.key(), false),
            AccountMeta::new(ctx.accounts.xdex_vault_1.key(), false),
            AccountMeta::new(ctx.accounts.xdex_create_pool_fee_receiver.key(), false),
            AccountMeta::new(ctx.accounts.xdex_observation_state.key(), false),
            AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
            AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
            AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
            AccountMeta::new_readonly(ctx.accounts.associated_token_program.key(), false),
            AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
            AccountMeta::new_readonly(ctx.accounts.rent.key(), false),
        ];
        let account_infos = vec![
            ctx.accounts.xdex_creator.to_account_info(),
            ctx.accounts.xdex_amm_config.to_account_info(),
            ctx.accounts.xdex_authority.to_account_info(),
            ctx.accounts.xdex_pool_state.to_account_info(),
            ctx.accounts.wxnt_mint.to_account_info(),
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.xdex_lp_mint.to_account_info(),
            ctx.accounts.curve_wxnt_ata.to_account_info(),
            ctx.accounts.curve_mint_ata.to_account_info(),
            ctx.accounts.curve_lp_ata.to_account_info(),
            ctx.accounts.xdex_vault_0.to_account_info(),
            ctx.accounts.xdex_vault_1.to_account_info(),
            ctx.accounts.xdex_create_pool_fee_receiver.to_account_info(),
            ctx.accounts.xdex_observation_state.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
            ctx.accounts.associated_token_program.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
            ctx.accounts.rent.to_account_info(),
            ctx.accounts.xdex_program.to_account_info(), // runtime requires the invoked
                                                          // program's own account be present
                                                          // among the CPI account_infos
        ];
        let ix = Instruction {
            program_id: XDEX_PROGRAM_ID,
            accounts: account_metas,
            data: ix_data,
        };
        invoke_signed(&ix, &account_infos, &[xdex_creator_seeds])?;

        // Permanently lock liquidity: burn every LP token the pool just minted back to us.
        // Nobody — including the admin — has any way to withdraw it afterward.
        let lp_amount = anchor_spl::token::accessor::amount(&ctx.accounts.curve_lp_ata.to_account_info())?;
        if lp_amount > 0 {
            token::burn(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Burn {
                        mint: ctx.accounts.xdex_lp_mint.to_account_info(),
                        from: ctx.accounts.curve_lp_ata.to_account_info(),
                        authority: ctx.accounts.xdex_creator.to_account_info(),
                    },
                    &[xdex_creator_seeds],
                ),
                lp_amount,
            )?;
        }

        let curve = &mut ctx.accounts.curve;
        curve.complete = true;
        curve.real_xnt_reserves = 0;

        emit!(LaunchpadGraduatedEvent {
            mint: mint_key,
            pool_state: ctx.accounts.xdex_pool_state.key(),
            lp_mint: ctx.accounts.xdex_lp_mint.key(),
            xnt_migrated: xnt_amount,
            tokens_migrated: token_amount,
            lp_burned: lp_amount,
        });
        Ok(())
    }
}

// ── Account contexts ─────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct InitGlobalConfig<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + LaunchpadGlobalConfig::INIT_SPACE,
        seeds = [GLOBAL_CONFIG_SEED],
        bump,
    )]
    pub config: Account<'info, LaunchpadGlobalConfig>,

    #[account(
        init,
        payer = payer,
        space = 8 + NativeVault::INIT_SPACE,
        seeds = [TREASURY_VAULT_SEED],
        bump,
    )]
    pub treasury_vault: Account<'info, NativeVault>,

    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: verified in `assert_upgrade_authority` against the bpf_loader_upgradeable
    /// ProgramData PDA — only the program's actual upgrade authority may initialize config.
    pub program_data: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdatePrice<'info> {
    #[account(mut, seeds = [GLOBAL_CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, LaunchpadGlobalConfig>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct RefreshPrice<'info> {
    #[account(mut, seeds = [GLOBAL_CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, LaunchpadGlobalConfig>,
    /// CHECK: XNT/USDC pool XNT vault — address constrained to XNT_USDC_XNT_VAULT constant.
    #[account(address = XNT_USDC_XNT_VAULT)]
    pub xnt_vault: UncheckedAccount<'info>,
    /// CHECK: XNT/USDC pool USDC vault — address constrained to XNT_USDC_USDC_VAULT constant.
    #[account(address = XNT_USDC_USDC_VAULT)]
    pub usdc_vault: UncheckedAccount<'info>,
}

// Token creation is split across four instructions (see comments on create_mint/init_curve/
// init_token_vaults/finalize_token above) purely to stay under the BPF stack limit. Every
// account field carrying meaningful state is boxed for the same reason — moves the account
// struct to the heap instead of the instruction's stack frame, same as mining_v2's larger
// instructions do.

#[derive(Accounts)]
#[instruction(name: String, symbol: String, uri: String)]
pub struct CreateMint<'info> {
    #[account(mut, seeds = [GLOBAL_CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, LaunchpadGlobalConfig>>,

    #[account(mut, seeds = [TREASURY_VAULT_SEED], bump = config.treasury_vault_bump)]
    pub treasury_vault: Box<Account<'info, NativeVault>>,

    #[account(mut)]
    pub creator: Signer<'info>,

    #[account(
        init,
        payer = creator,
        mint::decimals = TOKEN_DECIMALS,
        mint::authority = creator,
    )]
    pub mint: Box<Account<'info, Mint>>,

    #[account(
        init,
        payer = creator,
        associated_token::mint = mint,
        associated_token::authority = creator,
    )]
    pub creator_token_account: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct InitCurve<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    pub mint: Box<Account<'info, Mint>>,

    #[account(
        init,
        payer = creator,
        space = 8 + BondingCurve::INIT_SPACE,
        seeds = [CURVE_SEED, mint.key().as_ref()],
        bump,
    )]
    pub curve: Box<Account<'info, BondingCurve>>,

    #[account(
        init,
        payer = creator,
        space = 8 + NativeVault::INIT_SPACE,
        seeds = [CURVE_XNT_VAULT_SEED, mint.key().as_ref()],
        bump,
    )]
    pub curve_xnt_vault: Box<Account<'info, NativeVault>>,

    #[account(
        init,
        payer = creator,
        space = 8 + NativeVault::INIT_SPACE,
        seeds = [REWARD_POOL_XNT_SEED, mint.key().as_ref()],
        bump,
    )]
    pub reward_pool_xnt_vault: Box<Account<'info, NativeVault>>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitCurveTokenVault<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    pub mint: Box<Account<'info, Mint>>,

    #[account(mut, seeds = [CURVE_SEED, mint.key().as_ref()], bump = curve.bump, has_one = mint)]
    pub curve: Box<Account<'info, BondingCurve>>,

    #[account(
        init,
        payer = creator,
        seeds = [CURVE_TOKEN_VAULT_SEED, mint.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = curve,
    )]
    pub curve_token_vault: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct InitRewardPoolTokenVault<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    pub mint: Box<Account<'info, Mint>>,

    #[account(mut, seeds = [CURVE_SEED, mint.key().as_ref()], bump = curve.bump, has_one = mint)]
    pub curve: Box<Account<'info, BondingCurve>>,

    #[account(
        init,
        payer = creator,
        seeds = [REWARD_POOL_TOKEN_SEED, mint.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = curve,
    )]
    pub reward_pool_token_vault: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct InitGradReserveVault<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    pub mint: Box<Account<'info, Mint>>,

    #[account(mut, seeds = [CURVE_SEED, mint.key().as_ref()], bump = curve.bump, has_one = mint)]
    pub curve: Box<Account<'info, BondingCurve>>,

    #[account(
        init,
        payer = creator,
        seeds = [GRAD_RESERVE_SEED, mint.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = curve,
    )]
    pub grad_reserve_vault: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct FinalizeToken<'info> {
    #[account(mut, seeds = [GLOBAL_CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, LaunchpadGlobalConfig>>,

    #[account(mut)]
    pub creator: Signer<'info>,

    #[account(mut)]
    pub mint: Box<Account<'info, Mint>>,

    #[account(mut, seeds = [CURVE_SEED, mint.key().as_ref()], bump = curve.bump, has_one = mint)]
    pub curve: Box<Account<'info, BondingCurve>>,

    #[account(
        mut,
        seeds = [CURVE_TOKEN_VAULT_SEED, mint.key().as_ref()],
        bump = curve.curve_token_vault_bump,
    )]
    pub curve_token_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [REWARD_POOL_TOKEN_SEED, mint.key().as_ref()],
        bump = curve.reward_pool_token_vault_bump,
    )]
    pub reward_pool_token_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [GRAD_RESERVE_SEED, mint.key().as_ref()],
        bump = curve.grad_reserve_vault_bump,
    )]
    pub grad_reserve_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [REWARD_POOL_XNT_SEED, mint.key().as_ref()],
        bump = curve.reward_pool_xnt_vault_bump,
    )]
    pub reward_pool_xnt_vault: Box<Account<'info, NativeVault>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Trade<'info> {
    #[account(mut, seeds = [GLOBAL_CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, LaunchpadGlobalConfig>>,

    #[account(mut, seeds = [TREASURY_VAULT_SEED], bump = config.treasury_vault_bump)]
    pub treasury_vault: Box<Account<'info, NativeVault>>,

    #[account(
        mut,
        seeds = [CURVE_SEED, mint.key().as_ref()],
        bump = curve.bump,
        has_one = mint,
    )]
    pub curve: Box<Account<'info, BondingCurve>>,

    #[account(
        mut,
        seeds = [CURVE_XNT_VAULT_SEED, mint.key().as_ref()],
        bump = curve.curve_xnt_vault_bump,
    )]
    pub curve_xnt_vault: Box<Account<'info, NativeVault>>,

    #[account(
        mut,
        seeds = [REWARD_POOL_XNT_SEED, mint.key().as_ref()],
        bump = curve.reward_pool_xnt_vault_bump,
    )]
    pub reward_pool_xnt_vault: Box<Account<'info, NativeVault>>,

    #[account(
        mut,
        seeds = [CURVE_TOKEN_VAULT_SEED, mint.key().as_ref()],
        bump = curve.curve_token_vault_bump,
    )]
    pub curve_token_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [REWARD_POOL_TOKEN_SEED, mint.key().as_ref()],
        bump = curve.reward_pool_token_vault_bump,
    )]
    pub reward_pool_token_vault: Box<Account<'info, TokenAccount>>,

    pub mint: Box<Account<'info, Mint>>,

    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        constraint = user_token_account.mint == mint.key() @ LaunchpadError::InvalidTokenAccount,
        constraint = user_token_account.owner == user.key() @ LaunchpadError::InvalidTokenAccount,
    )]
    pub user_token_account: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DepositRewardPool<'info> {
    #[account(seeds = [CURVE_SEED, mint.key().as_ref()], bump = curve.bump, has_one = mint)]
    pub curve: Account<'info, BondingCurve>,

    #[account(
        mut,
        seeds = [REWARD_POOL_XNT_SEED, mint.key().as_ref()],
        bump = curve.reward_pool_xnt_vault_bump,
    )]
    pub reward_pool_xnt_vault: Account<'info, NativeVault>,

    pub mint: Account<'info, Mint>,

    #[account(mut)]
    pub depositor: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminWithdrawTreasury<'info> {
    #[account(seeds = [GLOBAL_CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, LaunchpadGlobalConfig>,

    #[account(mut, seeds = [TREASURY_VAULT_SEED], bump = config.treasury_vault_bump)]
    pub treasury_vault: Account<'info, NativeVault>,

    #[account(mut, address = config.admin @ LaunchpadError::Unauthorized)]
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct GraduatePrepare<'info> {
    /// Anyone may call this and cover the one-time rent buffer — permissionless, like pump.fun's
    /// own graduation trigger.
    #[account(mut)]
    pub payer: Signer<'info>,

    pub mint: Box<Account<'info, Mint>>,

    #[account(mut, seeds = [CURVE_SEED, mint.key().as_ref()], bump = curve.bump, has_one = mint)]
    pub curve: Box<Account<'info, BondingCurve>>,

    #[account(
        mut,
        seeds = [CURVE_XNT_VAULT_SEED, mint.key().as_ref()],
        bump = curve.curve_xnt_vault_bump,
    )]
    pub curve_xnt_vault: Box<Account<'info, NativeVault>>,

    #[account(
        mut,
        seeds = [GRAD_RESERVE_SEED, mint.key().as_ref()],
        bump = curve.grad_reserve_vault_bump,
    )]
    pub grad_reserve_vault: Box<Account<'info, TokenAccount>>,

    #[account(address = WXNT_MINT)]
    pub wxnt_mint: Box<Account<'info, Mint>>,

    /// CHECK: purely-a-signer PDA, never `init`'d as an Anchor account — stays System-owned
    /// with zero data so it's eligible to be xdex's rent-paying "creator" in graduate_finalize
    /// (Raydium's own `initialize` pays for its new accounts via plain System Program transfers,
    /// which require the source to be data-less; `curve` itself can't play that role since it's
    /// a real Anchor account with state). Funded with a small lamport buffer here.
    #[account(mut, seeds = [XDEX_CREATOR_SEED, mint.key().as_ref()], bump)]
    pub xdex_creator: UncheckedAccount<'info>,

    /// Canonical WXNT ATA owned by `xdex_creator` — xdex pools are plain SPL-token pairs, so
    /// the curve's real XNT gets wrapped in here before graduate_finalize's CPI.
    #[account(
        init,
        payer = payer,
        associated_token::mint = wxnt_mint,
        associated_token::authority = xdex_creator,
    )]
    pub curve_wxnt_ata: Box<Account<'info, TokenAccount>>,

    /// Canonical ATA (this mint) owned by `xdex_creator` — receives the 5% graduation
    /// allocation out of `grad_reserve_vault`.
    #[account(
        init,
        payer = payer,
        associated_token::mint = mint,
        associated_token::authority = xdex_creator,
    )]
    pub curve_mint_ata: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct GraduateFinalize<'info> {
    pub mint: Box<Account<'info, Mint>>,

    #[account(mut, seeds = [CURVE_SEED, mint.key().as_ref()], bump = curve.bump, has_one = mint)]
    pub curve: Box<Account<'info, BondingCurve>>,

    /// CHECK: same purely-a-signer PDA funded in graduate_prepare.
    #[account(mut, seeds = [XDEX_CREATOR_SEED, mint.key().as_ref()], bump)]
    pub xdex_creator: UncheckedAccount<'info>,

    #[account(
        mut,
        associated_token::mint = wxnt_mint,
        associated_token::authority = xdex_creator,
    )]
    pub curve_wxnt_ata: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = xdex_creator,
    )]
    pub curve_mint_ata: Box<Account<'info, TokenAccount>>,

    #[account(address = WXNT_MINT)]
    pub wxnt_mint: Box<Account<'info, Mint>>,

    /// CHECK: xdex's global fee-tier config — same address the existing MIND/XNT pool uses,
    /// shared by every pool on xdex, not created or owned by this program.
    #[account(address = XDEX_AMM_CONFIG)]
    pub xdex_amm_config: UncheckedAccount<'info>,

    /// CHECK: xdex's single global vault/LP-mint-authority PDA — verified byte-for-byte
    /// against a real xdex pool during Faza 1 research, not owned or written by us.
    #[account(
        seeds = [XDEX_AUTHORITY_SEED],
        bump,
        seeds::program = XDEX_PROGRAM_ID,
    )]
    pub xdex_authority: UncheckedAccount<'info>,

    /// CHECK: new xdex pool_state PDA for (WXNT, this mint) — created inside the CPI below.
    #[account(
        mut,
        seeds = [XDEX_POOL_SEED, xdex_amm_config.key().as_ref(), wxnt_mint.key().as_ref(), mint.key().as_ref()],
        bump,
        seeds::program = XDEX_PROGRAM_ID,
    )]
    pub xdex_pool_state: UncheckedAccount<'info>,

    /// CHECK: new xdex LP mint for this pool — created inside the CPI below.
    #[account(
        mut,
        seeds = [XDEX_POOL_LP_MINT_SEED, xdex_pool_state.key().as_ref()],
        bump,
        seeds::program = XDEX_PROGRAM_ID,
    )]
    pub xdex_lp_mint: UncheckedAccount<'info>,

    /// CHECK: LP ATA owned by `xdex_creator` — created and funded by the CPI below, then burned
    /// in full immediately after so this liquidity can never be withdrawn by anyone.
    #[account(mut, address = get_associated_token_address(&xdex_creator.key(), &xdex_lp_mint.key()))]
    pub curve_lp_ata: UncheckedAccount<'info>,

    /// CHECK: new xdex token vault for the WXNT side — created inside the CPI below.
    #[account(
        mut,
        seeds = [XDEX_POOL_VAULT_SEED, xdex_pool_state.key().as_ref(), wxnt_mint.key().as_ref()],
        bump,
        seeds::program = XDEX_PROGRAM_ID,
    )]
    pub xdex_vault_0: UncheckedAccount<'info>,

    /// CHECK: new xdex token vault for this mint's side — created inside the CPI below.
    #[account(
        mut,
        seeds = [XDEX_POOL_VAULT_SEED, xdex_pool_state.key().as_ref(), mint.key().as_ref()],
        bump,
        seeds::program = XDEX_PROGRAM_ID,
    )]
    pub xdex_vault_1: UncheckedAccount<'info>,

    /// CHECK: xdex's fixed pool-creation fee receiver — the same constant address every pool
    /// on xdex pays, not something this program controls.
    #[account(mut, address = XDEX_CREATE_POOL_FEE_RECEIVER)]
    pub xdex_create_pool_fee_receiver: UncheckedAccount<'info>,

    /// CHECK: new xdex price-observation PDA for this pool — created inside the CPI below.
    #[account(
        mut,
        seeds = [XDEX_OBSERVATION_SEED, xdex_pool_state.key().as_ref()],
        bump,
        seeds::program = XDEX_PROGRAM_ID,
    )]
    pub xdex_observation_state: UncheckedAccount<'info>,

    /// CHECK: xdex program itself — the Solana runtime requires the invoked program's own
    /// account be present among the CPI's account list even though it never appears in the
    /// instruction's own account metas.
    #[account(address = XDEX_PROGRAM_ID)]
    pub xdex_program: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

// ── State ────────────────────────────────────────────────────────────────────

#[account]
#[derive(InitSpace)]
pub struct LaunchpadGlobalConfig {
    pub admin: Pubkey,
    pub xnt_usd_cents: u64,
    pub fee_bps: u16,
    pub giga_min_usd_cents: u64,
    pub token_creation_fee_lamports: u64,
    pub total_tokens_created: u64,
    pub total_volume_xnt: u128,
    pub bump: u8,
    pub treasury_vault_bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct NativeVault {
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct BondingCurve {
    pub mint: Pubkey,
    pub creator: Pubkey,
    pub virtual_token_reserves: u64,
    pub virtual_xnt_reserves: u64,
    pub real_token_reserves: u64,
    pub real_xnt_reserves: u64,
    /// Native XNT side of the per-token GigaSwap jackpot — grows from 0.5% trade fees.
    pub reward_pool_xnt_balance: u64,
    /// Token side of the per-token GigaSwap jackpot — starts at 10% of total supply.
    pub reward_pool_token_balance: u64,
    pub trade_counter: u64,
    pub giga_hits: u64,
    /// Always false in v1 — reserved for a v2 graduation-to-AMM instruction.
    pub complete: bool,
    pub created_at: i64,
    pub bump: u8,
    pub curve_xnt_vault_bump: u8,
    pub reward_pool_xnt_vault_bump: u8,
    pub reward_pool_token_vault_bump: u8,
    pub curve_token_vault_bump: u8,
    pub grad_reserve_vault_bump: u8,
}

// ── Events ───────────────────────────────────────────────────────────────────

#[event]
pub struct GlobalConfigInitialized {
    pub admin: Pubkey,
    pub xnt_usd_cents: u64,
}

#[event]
pub struct LaunchpadMintCreated {
    pub mint: Pubkey,
    pub creator: Pubkey,
    pub name: String,
    pub symbol: String,
    pub uri: String,
}

#[event]
pub struct LaunchpadTokenCreated {
    pub mint: Pubkey,
    pub creator: Pubkey,
    pub curve: Pubkey,
    pub created_at: i64,
}

#[event]
pub struct LaunchpadTradeEvent {
    pub user: Pubkey,
    pub mint: Pubkey,
    pub is_buy: bool,
    pub xnt_amount: u64,
    pub token_amount: u64,
    pub fee_total: u64,
}

/// Byte layout mirrors swap_router's GigaSwapEvent (payout @ offset 64, bool @ offset 72,
/// counting from the start of the 8-byte Anchor discriminator) so the existing frontend/
/// scanner offset-based parser logic can be reused with a new discriminator lookup.
#[event]
pub struct LaunchpadGigaEvent {
    pub user: Pubkey,        // offset 8
    pub trade_counter: u64,  // offset 40
    pub usd_cents: u64,      // offset 48
    pub tier_bps: u64,       // offset 56
    pub payout: u64,         // offset 64
    pub paid_in_token: bool, // offset 72 — which side of the pool paid (mirrors paid_mind)
    pub mint: Pubkey,        // offset 73
}

#[event]
pub struct LaunchpadGraduatedEvent {
    pub mint: Pubkey,
    pub pool_state: Pubkey,
    pub lp_mint: Pubkey,
    pub xnt_migrated: u64,
    pub tokens_migrated: u64,
    pub lp_burned: u64,
}

// ── Errors ───────────────────────────────────────────────────────────────────

#[error_code]
pub enum LaunchpadError {
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Zero amount")]
    ZeroAmount,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Name too long")]
    NameTooLong,
    #[msg("Symbol too long")]
    SymbolTooLong,
    #[msg("URI too long")]
    UriTooLong,
    #[msg("Curve has already graduated")]
    CurveComplete,
    #[msg("Curve has not fully sold out yet")]
    CurveNotSoldOut,
    #[msg("Not enough tokens left on the curve")]
    SoldOut,
    #[msg("Not enough XNT liquidity on the curve")]
    InsufficientLiquidity,
    #[msg("Slippage tolerance exceeded")]
    SlippageExceeded,
    #[msg("Token account does not match expected mint/owner")]
    InvalidTokenAccount,
    #[msg("Invalid program data account")]
    InvalidProgramData,
    #[msg("Insufficient vault balance")]
    InsufficientVaultBalance,
}

// ── Helpers ──────────────────────────────────────────────────────────────────

struct GigaResult {
    payout: u64,
    tier_bps: u64,
    usd_cents: u64,
    paid_in_token: bool,
}

/// Mirrors swap_router's pseudo_random(): sha256(user || counter LE || slot LE || unix_ts LE),
/// first 8 bytes as a little-endian u64.
fn pseudo_random(user: &Pubkey, counter: u64) -> Result<u64> {
    let clock = Clock::get()?;
    let mixed = hashv(&[
        user.as_ref(),
        &counter.to_le_bytes(),
        &clock.slot.to_le_bytes(),
        &clock.unix_timestamp.to_le_bytes(),
    ]);
    Ok(u64::from_le_bytes(mixed.to_bytes()[..8].try_into().unwrap()))
}

/// Probability numerator (out of GIGA_BASE_DENOM=100) — copied 1:1 from swap_router.
fn giga_probability(usd_cents: u64) -> u64 {
    match usd_cents {
        0..=499 => 0,
        500..=1_599 => 38,
        1_600..=2_999 => 40,
        3_000..=4_699 => 42,
        4_700..=6_599 => 44,
        6_600..=8_699 => 46,
        8_700..=11_099 => 48,
        _ => 50,
    }
}

/// Maps rng + swap USD value to pool payout in basis points (out of 10_000) — copied 1:1
/// from swap_router. Uses rng >> 16 so the tier draw is independent of the win-probability
/// check (rng % 100); without that split, high tiers become unreachable.
fn pick_pool_pct(rng: u64, usd_cents: u64) -> u64 {
    let r = (rng >> 16) % 100;
    match usd_cents {
        500..=2_999 => match r {
            0..=59 => 100,
            60..=84 => 250,
            85..=96 => 500,
            _ => 900,
        },
        3_000..=9_999 => match r {
            0..=34 => 100,
            35..=59 => 250,
            60..=81 => 500,
            82..=93 => 900,
            94..=98 => 1500,
            _ => 2500,
        },
        10_000..=29_999 => match r {
            0..=19 => 100,
            20..=39 => 250,
            40..=61 => 500,
            62..=81 => 900,
            82..=93 => 1500,
            _ => 2500,
        },
        _ => match r {
            0..=9 => 100,
            10..=24 => 250,
            25..=44 => 500,
            45..=64 => 900,
            65..=84 => 1500,
            _ => 2500,
        },
    }
}

/// Dominant-pool GigaSwap check: values the token side of the reward pool using the curve's
/// own virtual-reserve price ratio (no external oracle read needed, unlike swap_router which
/// has to read an external xdex vault to price MIND), compares it in USD to the XNT side, and
/// pays out a random tier of whichever side is dominant — capped at 33% of that side.
#[allow(clippy::too_many_arguments)]
fn try_giga_swap<'info>(
    curve: &mut Box<Account<'info, BondingCurve>>,
    reward_pool_xnt_vault: &AccountInfo<'info>,
    reward_pool_token_vault: &Box<Account<'info, TokenAccount>>,
    user_token_account: &Box<Account<'info, TokenAccount>>,
    token_program: &AccountInfo<'info>,
    user: &AccountInfo<'info>,
    xnt_moved: u64,
    xnt_usd_cents: u64,
    curve_signer_seeds: &[&[u8]],
) -> Result<GigaResult> {
    let no_win = GigaResult {
        payout: 0,
        tier_bps: 0,
        usd_cents: 0,
        paid_in_token: false,
    };

    let usd_cents = ((xnt_moved as u128)
        .checked_mul(xnt_usd_cents as u128)
        .ok_or(LaunchpadError::MathOverflow)?
        / 1_000_000_000) as u64;
    if usd_cents < DEFAULT_GIGA_MIN_USD_CENTS {
        return Ok(no_win);
    }

    curve.trade_counter = curve
        .trade_counter
        .checked_add(1)
        .ok_or(LaunchpadError::MathOverflow)?;
    let rng = pseudo_random(&user.key(), curve.trade_counter)?;
    let probability = giga_probability(usd_cents);
    if rng % GIGA_BASE_DENOM >= probability {
        return Ok(no_win);
    }

    let token_pool_xnt_equiv = (curve.reward_pool_token_balance as u128)
        .saturating_mul(curve.virtual_xnt_reserves as u128)
        / (curve.virtual_token_reserves as u128).max(1);
    let token_pool_usd = token_pool_xnt_equiv.saturating_mul(xnt_usd_cents as u128) / 1_000_000_000;
    let xnt_pool_usd =
        (curve.reward_pool_xnt_balance as u128).saturating_mul(xnt_usd_cents as u128) / 1_000_000_000;
    let dominant_is_token = token_pool_usd > xnt_pool_usd;

    let pool_pct = pick_pool_pct(rng, usd_cents);
    let dominant_bal = if dominant_is_token {
        curve.reward_pool_token_balance
    } else {
        curve.reward_pool_xnt_balance
    };
    let payout = ((dominant_bal as u128)
        .checked_mul(pool_pct as u128)
        .ok_or(LaunchpadError::MathOverflow)?
        / BPS_DENOM) as u64;
    let payout = payout.min(dominant_bal / 3);
    if payout == 0 {
        return Ok(no_win);
    }

    if dominant_is_token {
        token::transfer(
            CpiContext::new_with_signer(
                token_program.clone(),
                SplTransfer {
                    from: reward_pool_token_vault.to_account_info(),
                    to: user_token_account.to_account_info(),
                    authority: curve.to_account_info(),
                },
                &[curve_signer_seeds],
            ),
            payout,
        )?;
        curve.reward_pool_token_balance = curve
            .reward_pool_token_balance
            .checked_sub(payout)
            .ok_or(LaunchpadError::MathOverflow)?;
    } else {
        transfer_lamports(reward_pool_xnt_vault, user, payout)?;
        curve.reward_pool_xnt_balance = curve
            .reward_pool_xnt_balance
            .checked_sub(payout)
            .ok_or(LaunchpadError::MathOverflow)?;
    }
    curve.giga_hits = curve.giga_hits.checked_add(1).ok_or(LaunchpadError::MathOverflow)?;

    Ok(GigaResult {
        payout,
        tier_bps: pool_pct,
        usd_cents,
        paid_in_token: dominant_is_token,
    })
}

/// Copied 1:1 from mining_v2 — only the program's actual upgrade authority may pass this.
fn assert_upgrade_authority(program_data: &AccountInfo, admin: Pubkey) -> Result<()> {
    let (expected, _) =
        Pubkey::find_program_address(&[crate::ID.as_ref()], &bpf_loader_upgradeable::ID);
    require_keys_eq!(expected, program_data.key(), LaunchpadError::InvalidProgramData);
    require!(
        program_data.owner == &bpf_loader_upgradeable::ID,
        LaunchpadError::InvalidProgramData
    );
    let data = program_data.try_borrow_data()?;
    let state: UpgradeableLoaderState =
        bincode::deserialize(&data).map_err(|_| LaunchpadError::InvalidProgramData)?;
    match state {
        UpgradeableLoaderState::ProgramData {
            upgrade_authority_address: Some(authority),
            ..
        } => {
            require_keys_eq!(authority, admin, LaunchpadError::Unauthorized);
        }
        _ => return Err(LaunchpadError::InvalidProgramData.into()),
    }
    Ok(())
}

/// Copied 1:1 from mining_v2 — NativeVault accounts are owned by this program, so direct
/// lamport manipulation (no CPI/signing) is legal for debits.
fn vault_available_lamports(vault: &Account<NativeVault>) -> Result<u64> {
    let rent = Rent::get()?.minimum_balance(8 + NativeVault::INIT_SPACE);
    Ok(vault.to_account_info().lamports().saturating_sub(rent))
}

fn transfer_lamports(from: &AccountInfo, to: &AccountInfo, amount: u64) -> Result<()> {
    let from_balance = **from.try_borrow_lamports()?;
    let to_balance = **to.try_borrow_lamports()?;
    **from.try_borrow_mut_lamports()? = from_balance
        .checked_sub(amount)
        .ok_or(LaunchpadError::InsufficientVaultBalance)?;
    **to.try_borrow_mut_lamports()? = to_balance
        .checked_add(amount)
        .ok_or(LaunchpadError::MathOverflow)?;
    Ok(())
}

/// Reads the raw SPL Token `amount` field (u64 LE at byte offset 64) directly from account
/// data — same trick swap_router's refresh_price uses to avoid a full TokenAccount deserialize.
fn read_account_amount(info: &AccountInfo) -> Result<u64> {
    let data = info.try_borrow_data()?;
    require!(data.len() >= 72, LaunchpadError::InvalidTokenAccount);
    let mut buf = [0u8; 8];
    buf.copy_from_slice(&data[64..72]);
    Ok(u64::from_le_bytes(buf))
}
