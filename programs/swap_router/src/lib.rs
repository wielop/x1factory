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

/// 1.0% total fee (0.5% treasury + 0.5% reward pool)
const FEE_BPS: u64 = 100;
const BPS_DENOM: u64 = 10_000;

/// Minimum swap value in USD cents to qualify for GigaSwap ($5.00)
const GIGA_MIN_USD_CENTS: u64 = 500;

/// Probability denominator: giga_probability() returns numerator out of this
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
        cfg.reward_pool_xnt_balance = 0;
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
    /// GigaSwap: if swap value ≥ $5, random bonus paid from dominant pool token.
    pub fn swap_base_input<'info>(
        ctx: Context<'_, '_, '_, 'info, SwapBaseInput<'info>>,
        amount_in: u64,
        minimum_amount_out: u64,
    ) -> Result<()> {
        require!(amount_in > 0, RouterError::ZeroAmount);
        do_swap(ctx, amount_in, minimum_amount_out)
    }

    /// Authority withdraws from reward pool (admin function).
    /// token_is_mind: true = withdraw MIND, false = withdraw XNT (WXNT)
    pub fn withdraw_reward_pool(
        ctx: Context<WithdrawRewardPool>,
        amount: u64,
        token_is_mind: bool,
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
        if token_is_mind {
            ctx.accounts.config.reward_pool_mind_balance = ctx
                .accounts.config.reward_pool_mind_balance.saturating_sub(amount);
        } else {
            ctx.accounts.config.reward_pool_xnt_balance = ctx
                .accounts.config.reward_pool_xnt_balance.saturating_sub(amount);
        }
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

    /// PDA that owns the reward pool token accounts
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
    /// CHECK: XNT/USDC pool XNT vault — address constrained to XNT_USDC_XNT_VAULT constant.
    #[account(address = XNT_USDC_XNT_VAULT)]
    pub xnt_vault: UncheckedAccount<'info>,
    /// CHECK: XNT/USDC pool USDC vault — address constrained to XNT_USDC_USDC_VAULT constant.
    #[account(address = XNT_USDC_USDC_VAULT)]
    pub usdc_vault: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct SwapBaseInput<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, RouterConfig>,

    /// PDA owning both reward pool ATAs
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

    /// Reward pool ATA for input token (receives 0.2% fee)
    #[account(mut)]
    pub reward_pool_input_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    // xdex accounts passed as remaining_accounts in order:
    // [0] xdex_authority, [1] amm_config, [2] pool_state (mut),
    // [3] input_vault (mut), [4] output_vault (mut),
    // [5] input_token_program, [6] output_token_program,
    // [7] input_mint, [8] output_mint, [9] observation_state (mut)
    // [10] xdex_program_id (X1 CPI requirement)
    // [11] reward_pool_output_account (mut) — GigaSwap payout for output token
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
    /// XNT price in USD cents (e.g. 50 = $0.50). Auto-updated via refresh_price.
    pub xnt_usd_cents: u64,
    pub swap_counter: u64,
    pub giga_hits: u64,
    /// Accumulated MIND lamports in reward pool (tracked for UI + GigaSwap)
    pub reward_pool_mind_balance: u64,
    /// Accumulated WXNT lamports in reward pool
    pub reward_pool_xnt_balance: u64,
    pub bump: u8,
    pub reward_pool_bump: u8,
}

impl RouterConfig {
    // 2 pubkeys (64) + 6 u64s (48) + 2 u8s (2) + 50 padding = 164
    const SIZE: usize = 64 + 48 + 2 + 50;
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
    pub paid_mind: bool,
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

/// Read token amount (u64 at offset 64) from a raw SPL token account (UncheckedAccount).
fn token_account_amount(account: &UncheckedAccount) -> Result<u64> {
    let data = account.try_borrow_data()?;
    require!(data.len() >= 72, RouterError::ZeroAmount);
    Ok(u64::from_le_bytes(data[64..72].try_into().unwrap()))
}

/// Swap logic extracted to its own #[inline(never)] frame to stay within BPF stack limit.
#[inline(never)]
fn do_swap<'info>(
    ctx: Context<'_, '_, '_, 'info, SwapBaseInput<'info>>,
    amount_in: u64,
    minimum_amount_out: u64,
) -> Result<()> {
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

    let input_is_mind = ctx.accounts.user_input_account.mint == MIND_MINT;
    if input_is_mind {
        ctx.accounts.config.reward_pool_mind_balance =
            ctx.accounts.config.reward_pool_mind_balance.saturating_add(pool_fee);
    } else {
        ctx.accounts.config.reward_pool_xnt_balance =
            ctx.accounts.config.reward_pool_xnt_balance.saturating_add(pool_fee);
    }

    let r = ctx.remaining_accounts;
    require!(r.len() >= 10, RouterError::ZeroAmount);
    let input_vault_raw = read_account_amount(&r[3]);
    let output_vault_raw = read_account_amount(&r[4]);

    let (xnt_vault_raw, mind_vault_raw) = if input_is_mind {
        (output_vault_raw, input_vault_raw)
    } else {
        (input_vault_raw, output_vault_raw)
    };

    let usd_value = compute_swap_usd(
        swap_amount,
        input_is_mind,
        ctx.accounts.config.xnt_usd_cents,
        xnt_vault_raw,
        mind_vault_raw,
    );

    cpi_xdex_swap(
        ctx.accounts.user.to_account_info(),
        ctx.accounts.user_input_account.to_account_info(),
        ctx.accounts.user_output_account.to_account_info(),
        r,
        swap_amount,
        minimum_amount_out,
    )?;

    ctx.accounts.config.swap_counter =
        ctx.accounts.config.swap_counter.checked_add(1).unwrap();

    let giga_result = process_giga_swap(
        &ctx,
        usd_value,
        fee_total,
        xnt_vault_raw,
        mind_vault_raw,
        input_is_mind,
    )?;

    if giga_result.payout > 0 {
        if giga_result.paid_mind {
            ctx.accounts.config.reward_pool_mind_balance =
                ctx.accounts.config.reward_pool_mind_balance.saturating_sub(giga_result.payout);
        } else {
            ctx.accounts.config.reward_pool_xnt_balance =
                ctx.accounts.config.reward_pool_xnt_balance.saturating_sub(giga_result.payout);
        }
        ctx.accounts.config.giga_hits += 1;
        emit!(GigaSwapEvent {
            user: ctx.accounts.user.key(),
            swap_counter: ctx.accounts.config.swap_counter,
            usd_cents: usd_value,
            multiplier: giga_result.multiplier,
            payout: giga_result.payout,
            paid_mind: giga_result.paid_mind,
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

/// USD value of swap_amount in cents, derived from pool vault ratio + XNT/USD price.
#[inline(never)]
fn compute_swap_usd(
    swap_amount: u64,
    input_is_mind: bool,
    xnt_usd_cents: u64,
    xnt_vault_raw: u64,
    mind_vault_raw: u64,
) -> u64 {
    if input_is_mind {
        if mind_vault_raw == 0 { return 0; }
        ((swap_amount as u128)
            .saturating_mul(xnt_usd_cents as u128)
            .saturating_mul(xnt_vault_raw as u128)
            / (mind_vault_raw as u128)
            / 1_000_000_000) as u64
    } else {
        ((swap_amount as u128).saturating_mul(xnt_usd_cents as u128) / 1_000_000_000) as u64
    }
}

/// Read token amount from a generic AccountInfo (for remaining_accounts).
fn read_account_amount(info: &AccountInfo) -> u64 {
    let data = info.try_borrow_data().ok();
    if let Some(d) = data {
        if d.len() >= 72 {
            return u64::from_le_bytes(d[64..72].try_into().unwrap_or([0u8; 8]));
        }
    }
    0
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

struct GigaResult {
    payout: u64,
    multiplier: u64,
    paid_mind: bool,
}

/// GigaSwap: if swap qualifies (≥ $5 USD), random chance to win bonus.
/// Payout = fee_total × multiplier, capped by dominant pool balance.
/// fee_total × mult is bot-proof: bots can never win more than they paid in fees.
/// remaining[11] = reward_pool_output_account (mut)
#[inline(never)]
fn process_giga_swap<'info>(
    ctx: &Context<'_, '_, '_, 'info, SwapBaseInput<'info>>,
    usd_value: u64,
    fee_total: u64,
    xnt_vault_raw: u64,
    mind_vault_raw: u64,
    input_is_mind: bool,
) -> Result<GigaResult> {
    let no_win = GigaResult { payout: 0, multiplier: 0, paid_mind: false };

    if usd_value < GIGA_MIN_USD_CENTS {
        return Ok(no_win);
    }

    let rng = pseudo_random(&ctx.accounts.user.key(), ctx.accounts.config.swap_counter);
    let probability = giga_probability(usd_value);
    if rng % GIGA_BASE_DENOM >= probability {
        return Ok(no_win);
    }

    let multiplier = pick_multiplier(rng);
    let xnt_usd = ctx.accounts.config.xnt_usd_cents;
    let mind_bal = ctx.accounts.config.reward_pool_mind_balance;
    let xnt_bal = ctx.accounts.config.reward_pool_xnt_balance;

    let xnt_pool_usd = (xnt_bal as u128).saturating_mul(xnt_usd as u128) / 1_000_000_000;
    let mind_pool_usd = if mind_vault_raw > 0 {
        (mind_bal as u128)
            .saturating_mul(xnt_usd as u128)
            .saturating_mul(xnt_vault_raw as u128)
            / (mind_vault_raw as u128)
            / 1_000_000_000
    } else {
        0
    };

    let dominant_is_mind = mind_pool_usd > xnt_pool_usd;
    let dominant_bal = if dominant_is_mind { mind_bal } else { xnt_bal };

    if dominant_bal == 0 {
        return Ok(no_win);
    }

    // Formula B: base = fee × mult; bonus = 0.2% of pool (max 4× fee); capped by pool.
    let base_payout = fee_total.saturating_mul(multiplier);
    let pool_bonus  = (dominant_bal / 500).min(fee_total.saturating_mul(4));
    let payout = base_payout.saturating_add(pool_bonus).min(dominant_bal);
    if payout == 0 {
        return Ok(no_win);
    }

    let config_key = ctx.accounts.config.key();
    let bump = ctx.accounts.config.reward_pool_bump;
    let seeds: &[&[u8]] = &[REWARD_POOL_SEED, config_key.as_ref(), &[bump]];

    // dominant_is_mind == input_is_mind → same-side token: pool_input → user_input
    // dominant_is_mind != input_is_mind → cross-side: pool_output (remaining[11]) → user_output
    let r = ctx.remaining_accounts;
    let (from_ata, to_ata) = if dominant_is_mind == input_is_mind {
        (
            ctx.accounts.reward_pool_input_account.to_account_info(),
            ctx.accounts.user_input_account.to_account_info(),
        )
    } else {
        require!(r.len() >= 12, RouterError::ZeroAmount);
        (r[11].clone(), ctx.accounts.user_output_account.to_account_info())
    };

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: from_ata,
                to: to_ata,
                authority: ctx.accounts.reward_pool_mind.to_account_info(),
            },
            &[seeds],
        ),
        payout,
    )?;

    Ok(GigaResult { payout, multiplier, paid_mind: dominant_is_mind })
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
            r[0].clone(), r[1].clone(), r[2].clone(),
            user_input, user_output,
            r[3].clone(), r[4].clone(),
            r[5].clone(), r[6].clone(),
            r[7].clone(), r[8].clone(), r[9].clone(),
        ],
    )?;

    Ok(())
}

/// Pseudo-random u64 from user key + swap counter + current slot + timestamp.
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

/// Probability numerator (out of GIGA_BASE_DENOM=100).
/// HIGH preset — generous win rates to reward all users.
fn giga_probability(usd_cents: u64) -> u64 {
    match usd_cents {
        0..=99          => 0,  // below $1  — no GigaSwap
        100..=199       => 18, // $1–$2     → 18%
        200..=499       => 28, // $2–$5     → 28%
        500..=1_999     => 38, // $5–$20    → 38%
        2_000..=9_999   => 55, // $20–$100  → 55%
        _               => 68, // $100+     → 68%
    }
}

/// Maps rng to payout multiplier (calibrated from simulation).
fn pick_multiplier(rng: u64) -> u64 {
    match rng % 100 {
        0..=34  => 1,  // 35%: 1×
        35..=59 => 2,  // 25%: 2×
        60..=76 => 3,  // 17%: 3×
        77..=88 => 5,  // 12%: 5×
        89..=95 => 8,  //  7%: 8×
        _        => 15, //  5%: 15× jackpot
    }
}
