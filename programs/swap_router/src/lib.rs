use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::hash::hashv;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

declare_id!("2xXG9bbggrffG976okAbEHzw1BJgfA58d9zHTToke2Z6");

// ── Constants ────────────────────────────────────────────────────────────────

const XDEX_PROGRAM_ID: Pubkey =
    solana_program::pubkey!("sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN");

const TREASURY: Pubkey =
    solana_program::pubkey!("AHrSKaFPWxt2YMZ7Q3xxpuC4wb622C3jUhER2p1V6VZS");

const MIND_MINT: Pubkey =
    solana_program::pubkey!("DohWBfvXER6qs8zFGtdZRDpgbHmm97ZZwgCUTCdtHQNT");

/// XNT/USDC pool on xdex — used for on-chain price refresh
/// token_0_vault = XNT (9 decimals), token_1_vault = USDC (6 decimals)
const XNT_USDC_XNT_VAULT: Pubkey =
    solana_program::pubkey!("8wvV4HKBDFMLEUkVWp1WPNa5ano99XCm3f9t3troyLb");
const XNT_USDC_USDC_VAULT: Pubkey =
    solana_program::pubkey!("7iw2adw8Af7x3pY7gj5RwczFXuGjCoX92Gfy3avwXQtg");

/// 0.4% total fee in basis points
const FEE_BPS: u64 = 40;
const BPS_DENOM: u64 = 10_000;

/// Minimum swap value in USD cents to qualify for giga swap ($5.00)
const GIGA_MIN_USD_CENTS: u64 = 500;

/// Giga swap base probability denominator (1 in N chance)
const GIGA_BASE_DENOM: u64 = 100;


const CONFIG_SEED: &[u8] = b"router_config";
const REWARD_POOL_SEED: &[u8] = b"reward_pool";

// ── xdex instruction discriminators (Anchor sha256("global:{name}")[..8]) ───

/// sha256("global:swap_base_input")[..8]
const XDEX_SWAP_BASE_INPUT_DISC: [u8; 8] = [143, 190, 90, 218, 196, 30, 51, 222];

// ── Program ──────────────────────────────────────────────────────────────────

#[program]
pub mod swap_router {
    use super::*;

    /// One-time setup. Called by TREASURY wallet.
    pub fn initialize(ctx: Context<Initialize>, xnt_usd_cents: u64) -> Result<()> {
        let cfg = &mut ctx.accounts.config;
        cfg.authority = TREASURY;
        cfg.treasury = TREASURY;
        cfg.xnt_usd_cents = xnt_usd_cents;
        cfg.swap_counter = 0;
        cfg.giga_hits = 0;
        cfg.reward_pool_mind_balance = 0;
        cfg.bump = *ctx.bumps.get("config").unwrap();
        cfg.reward_pool_bump = *ctx.bumps.get("reward_pool_mind").unwrap();
        Ok(())
    }

    /// Admin override: manually set XNT/USD price (in cents, e.g. 50 = $0.50).
    pub fn update_price(ctx: Context<UpdatePrice>, xnt_usd_cents: u64) -> Result<()> {
        require!(
            ctx.accounts.authority.key() == TREASURY,
            RouterError::Unauthorized
        );
        ctx.accounts.config.xnt_usd_cents = xnt_usd_cents;
        Ok(())
    }

    /// Permissionless: refresh XNT/USD price from on-chain XNT/USDC pool vaults.
    /// Works with both Token and Token-2022 (reads raw account data). Anyone can call.
    /// Price = usdc_vault_raw * 100_000 / xnt_vault_raw (cents, USDC 6dec / XNT 9dec).
    pub fn refresh_price(ctx: Context<RefreshPrice>) -> Result<()> {
        let xnt_raw = token_account_amount(&ctx.accounts.xnt_vault)?;
        let usdc_raw = token_account_amount(&ctx.accounts.usdc_vault)?;
        require!(xnt_raw > 0, RouterError::ZeroAmount);
        let cents = (usdc_raw as u128)
            .saturating_mul(100_000)
            .checked_div(xnt_raw as u128)
            .unwrap_or(0) as u64;
        ctx.accounts.config.xnt_usd_cents = cents;
        Ok(())
    }

    /// Main swap: MIND → XNT or XNT (wrapped) → MIND, routed through xdex.
    /// Fee 0.4% taken from input token:
    ///   0.2% → treasury wallet
    ///   0.2% → reward_pool PDA
    /// Remaining 99.6% sent to xdex via CPI.
    pub fn swap_base_input<'info>(
        ctx: Context<'_, '_, '_, 'info, SwapBaseInput<'info>>,
        amount_in: u64,
        minimum_amount_out: u64,
    ) -> Result<()> {
        require!(amount_in > 0, RouterError::ZeroAmount);
        let fee_total = amount_in.checked_mul(FEE_BPS).unwrap().checked_div(BPS_DENOM).unwrap();
        let treasury_fee = fee_total / 2;
        let pool_fee = fee_total - treasury_fee;
        let swap_amount = amount_in - fee_total;

        cpi_transfer_fee(
            ctx.accounts.token_program.to_account_info(),
            ctx.accounts.user_input_account.to_account_info(),
            ctx.accounts.treasury_input_account.to_account_info(),
            ctx.accounts.user.to_account_info(),
            treasury_fee,
        )?;
        cpi_transfer_fee(
            ctx.accounts.token_program.to_account_info(),
            ctx.accounts.user_input_account.to_account_info(),
            ctx.accounts.reward_pool_input_account.to_account_info(),
            ctx.accounts.user.to_account_info(),
            pool_fee,
        )?;

        if ctx.accounts.user_input_account.mint == MIND_MINT {
            ctx.accounts.config.reward_pool_mind_balance =
                ctx.accounts.config.reward_pool_mind_balance.saturating_add(pool_fee);
        }

        cpi_xdex_swap(
            ctx.accounts.user.to_account_info(),
            ctx.accounts.user_input_account.to_account_info(),
            ctx.accounts.user_output_account.to_account_info(),
            ctx.remaining_accounts,
            swap_amount,
            minimum_amount_out,
        )?;

        ctx.accounts.config.swap_counter =
            ctx.accounts.config.swap_counter.checked_add(1).unwrap();

        let usd_value = compute_usd_cents(
            swap_amount,
            ctx.accounts.user_input_account.mint,
            ctx.accounts.config.xnt_usd_cents,
        );

        let (giga_payout, giga_mult) = process_giga_swap(&ctx, usd_value)?;
        if giga_payout > 0 {
            ctx.accounts.config.reward_pool_mind_balance =
                ctx.accounts.config.reward_pool_mind_balance.saturating_sub(giga_payout);
            ctx.accounts.config.giga_hits += 1;
            emit!(GigaSwapEvent {
                user: ctx.accounts.user.key(),
                swap_counter: ctx.accounts.config.swap_counter,
                usd_cents: usd_value,
                multiplier: giga_mult,
                payout: giga_payout,
            });
        }

        emit!(SwapRouterEvent {
            user: ctx.accounts.user.key(),
            amount_in,
            swap_amount,
            fee_total,
            swap_counter: ctx.accounts.config.swap_counter,
            usd_cents: usd_value,
        });

        Ok(())
    }

    /// Authority withdraws from reward pool (admin function).
    pub fn withdraw_reward_pool(
        ctx: Context<WithdrawRewardPool>,
        amount: u64,
    ) -> Result<()> {
        require!(
            ctx.accounts.authority.key() == TREASURY,
            RouterError::Unauthorized
        );
        let config_key = ctx.accounts.config.key();
        let seeds = &[
            REWARD_POOL_SEED,
            config_key.as_ref(),
            &[ctx.accounts.config.reward_pool_bump],
        ];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.reward_pool_account.to_account_info(),
                    to: ctx.accounts.destination.to_account_info(),
                    authority: ctx.accounts.reward_pool_mind.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )?;
        ctx.accounts.config.reward_pool_mind_balance = ctx
            .accounts
            .config
            .reward_pool_mind_balance
            .saturating_sub(amount);
        Ok(())
    }
}

// ── Account contexts ─────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + RouterConfig::SIZE,
        seeds = [CONFIG_SEED],
        bump,
    )]
    pub config: Account<'info, RouterConfig>,

    /// PDA that owns the reward pool token account
    #[account(
        seeds = [REWARD_POOL_SEED, config.key().as_ref()],
        bump,
    )]
    pub reward_pool_mind: SystemAccount<'info>,

    #[account(mut, address = TREASURY)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdatePrice<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, RouterConfig>,
    #[account(address = TREASURY)]
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct RefreshPrice<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, RouterConfig>,
    /// XNT/USDC pool XNT vault (token_0, 9 dec). UncheckedAccount = works for Token-2022 too.
    #[account(address = XNT_USDC_XNT_VAULT)]
    pub xnt_vault: UncheckedAccount<'info>,
    /// XNT/USDC pool USDC vault (token_1, 6 dec, Token-2022)
    #[account(address = XNT_USDC_USDC_VAULT)]
    pub usdc_vault: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct SwapBaseInput<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, RouterConfig>,

    /// PDA owning the reward pool ATA
    #[account(
        seeds = [REWARD_POOL_SEED, config.key().as_ref()],
        bump = config.reward_pool_bump,
    )]
    pub reward_pool_mind: SystemAccount<'info>,

    /// User signing the transaction
    pub user: Signer<'info>,

    /// User's input token account (MIND or WXNT)
    #[account(mut)]
    pub user_input_account: Account<'info, TokenAccount>,

    /// User's output token account
    #[account(mut)]
    pub user_output_account: Account<'info, TokenAccount>,

    /// Treasury's ATA for input token (receives 0.2%)
    #[account(mut)]
    pub treasury_input_account: Account<'info, TokenAccount>,

    /// Reward pool ATA for input token (receives 0.2%), owned by reward_pool_mind PDA
    #[account(mut)]
    pub reward_pool_input_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    // xdex accounts passed as remaining_accounts in order:
    // [0] xdex_authority, [1] amm_config, [2] pool_state (mut),
    // [3] input_vault (mut), [4] output_vault (mut),
    // [5] input_token_program, [6] output_token_program,
    // [7] input_mint, [8] output_mint, [9] observation_state (mut)
}

#[derive(Accounts)]
pub struct WithdrawRewardPool<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, RouterConfig>,
    #[account(
        seeds = [REWARD_POOL_SEED, config.key().as_ref()],
        bump = config.reward_pool_bump,
    )]
    pub reward_pool_mind: SystemAccount<'info>,
    #[account(mut)]
    pub reward_pool_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub destination: Account<'info, TokenAccount>,
    #[account(address = TREASURY)]
    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

// ── State ─────────────────────────────────────────────────────────────────────

#[account]
pub struct RouterConfig {
    pub authority: Pubkey,
    pub treasury: Pubkey,
    /// XNT price in USD cents (e.g. 50 = $0.50). Updated by authority.
    pub xnt_usd_cents: u64,
    pub swap_counter: u64,
    pub giga_hits: u64,
    /// Tracks accumulated MIND in reward pool (for UI display)
    pub reward_pool_mind_balance: u64,
    pub bump: u8,
    pub reward_pool_bump: u8,
}

impl RouterConfig {
    // 2 pubkeys + 5 u64s + 2 u8s
    const SIZE: usize = 32 + 32 + 8 + 8 + 8 + 8 + 1 + 1 + 64; // 64 padding
}

// ── Events ────────────────────────────────────────────────────────────────────

#[event]
pub struct SwapRouterEvent {
    pub user: Pubkey,
    pub amount_in: u64,
    pub swap_amount: u64,
    pub fee_total: u64,
    pub swap_counter: u64,
    pub usd_cents: u64,
}

#[event]
pub struct GigaSwapEvent {
    pub user: Pubkey,
    pub swap_counter: u64,
    pub usd_cents: u64,
    pub multiplier: u64,
    pub payout: u64,
}

// ── Errors ────────────────────────────────────────────────────────────────────

#[error_code]
pub enum RouterError {
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Zero amount")]
    ZeroAmount,
    #[msg("Insufficient reward pool")]
    InsufficientPool,
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Read `amount` (u64 at offset 64) from a raw SPL token account.
/// Identical layout for Token and Token-2022 base accounts.
fn token_account_amount(account: &UncheckedAccount) -> Result<u64> {
    let data = account.try_borrow_data()?;
    require!(data.len() >= 72, RouterError::ZeroAmount);
    Ok(u64::from_le_bytes(data[64..72].try_into().unwrap()))
}

#[inline(never)]
fn cpi_transfer_fee<'info>(
    token_program: AccountInfo<'info>,
    from: AccountInfo<'info>,
    to: AccountInfo<'info>,
    authority: AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    token::transfer(
        CpiContext::new(
            token_program,
            Transfer { from, to, authority },
        ),
        amount,
    )
}

/// Returns (payout, multiplier) if giga swap triggered, else (0, 0).
/// State mutations applied by caller to keep config borrowing simple.
#[inline(never)]
fn process_giga_swap(ctx: &Context<SwapBaseInput>, usd_value: u64) -> Result<(u64, u64)> {
    if usd_value < GIGA_MIN_USD_CENTS {
        return Ok((0, 0));
    }
    let rng = pseudo_random(&ctx.accounts.user.key(), ctx.accounts.config.swap_counter);
    let probability = giga_probability(usd_value);
    if rng % GIGA_BASE_DENOM >= probability {
        return Ok((0, 0));
    }

    let multiplier = pick_multiplier(rng);
    let pool_bal = ctx.accounts.config.reward_pool_mind_balance;
    let payout = ((pool_bal / 20) * multiplier).min(pool_bal);
    if payout == 0 {
        return Ok((0, 0));
    }

    let config_key = ctx.accounts.config.key();
    let bump = ctx.accounts.config.reward_pool_bump;
    let seeds: &[&[u8]] = &[REWARD_POOL_SEED, config_key.as_ref(), &[bump]];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.reward_pool_input_account.to_account_info(),
                to: ctx.accounts.user_output_account.to_account_info(),
                authority: ctx.accounts.reward_pool_mind.to_account_info(),
            },
            &[seeds],
        ),
        payout,
    )?;

    Ok((payout, multiplier))
}

/// CPI to xdex swapBaseInput.
/// remaining_accounts order (10 accounts):
///   [0] xdex_authority, [1] amm_config, [2] pool_state (mut),
///   [3] input_vault (mut), [4] output_vault (mut),
///   [5] input_token_program, [6] output_token_program,
///   [7] input_mint, [8] output_mint, [9] observation_state (mut)
#[inline(never)]
fn cpi_xdex_swap<'info>(
    user: AccountInfo<'info>,
    user_input: AccountInfo<'info>,
    user_output: AccountInfo<'info>,
    remaining: &[AccountInfo<'info>],
    swap_amount: u64,
    minimum_amount_out: u64,
) -> Result<()> {
    require!(remaining.len() >= 10, RouterError::ZeroAmount);

    let mut data = XDEX_SWAP_BASE_INPUT_DISC.to_vec();
    data.extend_from_slice(&swap_amount.to_le_bytes());
    data.extend_from_slice(&minimum_amount_out.to_le_bytes());

    let r = remaining;
    let accounts = vec![
        AccountMeta::new_readonly(user.key(), true),
        AccountMeta::new_readonly(r[0].key(), false),
        AccountMeta::new_readonly(r[1].key(), false),
        AccountMeta::new(r[2].key(), false),
        AccountMeta::new(user_input.key(), false),
        AccountMeta::new(user_output.key(), false),
        AccountMeta::new(r[3].key(), false),
        AccountMeta::new(r[4].key(), false),
        AccountMeta::new_readonly(r[5].key(), false),
        AccountMeta::new_readonly(r[6].key(), false),
        AccountMeta::new_readonly(r[7].key(), false),
        AccountMeta::new_readonly(r[8].key(), false),
        AccountMeta::new(r[9].key(), false),
    ];

    let ix = Instruction { program_id: XDEX_PROGRAM_ID, accounts, data };

    invoke(
        &ix,
        &[
            user,
            r[0].clone(),
            r[1].clone(),
            r[2].clone(),
            user_input,
            user_output,
            r[3].clone(),
            r[4].clone(),
            r[5].clone(),
            r[6].clone(),
            r[7].clone(),
            r[8].clone(),
            r[9].clone(),
        ],
    )?;
    Ok(())
}

/// Computes approximate USD cents value of `amount` tokens.
/// If mint == MIND_MINT we'd need MIND price too; for now only XNT price is tracked.
/// For MIND input swaps: approximate using XNT price as reference (TODO: add MIND oracle).
fn compute_usd_cents(amount: u64, _mint: Pubkey, xnt_usd_cents: u64) -> u64 {
    // XNT has 9 decimals (like SOL). MIND decimals assumed 9.
    // usd_cents = amount * price / 10^9
    // To avoid overflow: amount / 10^7 * price / 100
    let units = amount / 10_000_000; // amount in units of 0.01 token
    units.saturating_mul(xnt_usd_cents) / 100
}

/// Pseudo-random u64 from slot hashes sysvar + user key + counter.
/// Not cryptographically secure — acceptable for gaming context.
fn pseudo_random(user: &Pubkey, counter: u64) -> u64 {
    let clock = Clock::get().unwrap();
    let mixed = hashv(&[
        user.as_ref(),
        &counter.to_le_bytes(),
        &clock.slot.to_le_bytes(),
        &clock.unix_timestamp.to_le_bytes(),
    ]);
    u64::from_le_bytes(mixed.to_bytes()[..8].try_into().unwrap())
}

/// Returns probability numerator (out of GIGA_BASE_DENOM=100).
/// Higher USD value → higher chance.
fn giga_probability(usd_cents: u64) -> u64 {
    match usd_cents {
        0..=499 => 0,           // below $5 — no chance
        500..=1_999 => 1,       // $5–$19.99 → 1%
        2_000..=9_999 => 3,     // $20–$99.99 → 3%
        10_000..=49_999 => 7,   // $100–$499.99 → 7%
        _ => 15,                // $500+ → 15%
    }
}

/// Maps rng to a giga multiplier: 1.5x/2x/3x/5x/10x (encoded as integer×10).
/// Returned as integer multiplier (reward = base * mult).
fn pick_multiplier(rng: u64) -> u64 {
    match rng % 100 {
        0..=39  => 1,   // 40% → no extra (1x, just pool base)
        40..=69 => 2,   // 30% → 2x
        70..=87 => 3,   // 18% → 3x
        88..=96 => 5,   // 9% → 5x
        _        => 10, // 3% → 10x
    }
}
