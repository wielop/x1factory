import { PublicKey, SystemProgram, TransactionInstruction, type Connection } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { blob, Layout as LayoutCls, struct, u8 } from "buffer-layout";
import BN from "bn.js";

export const RIPPER_POOL_ADDRESS = new PublicKey(
  "R1PP3RkqTJniWgzJgeymd4rFpdpXcmjywVomMpd8eAY"
);
export const RIPPER_POOL_PROGRAM_ID = new PublicKey(
  "XPoo1Fx6KNgeAzFcq2dPTo95bWGUSj5KdPVqYj9CZux"
);

type StakePoolLayoutDecoded = {
  reserveStake: PublicKey;
  poolMint: PublicKey;
  managerFeeAccount: PublicKey;
  solDepositAuthority: PublicKey | null;
  totalLamports: BN;
  poolTokenSupply: BN;
};

export type RipperStakePool = {
  reserveStake: PublicKey;
  poolMint: PublicKey;
  managerFeeAccount: PublicKey;
  solDepositAuthority: PublicKey | null;
  totalLamports: bigint;
  poolTokenSupply: bigint;
};

class BNLayout extends LayoutCls<BN> {
  blob: ReturnType<typeof blob>;
  signed: boolean;

  constructor(span: number, signed: boolean, property?: string) {
    super(span, property);
    this.blob = blob(span);
    this.signed = signed;
  }

  decode(b: Buffer, offset = 0) {
    const num = new BN(this.blob.decode(b, offset), 10, "le");
    if (this.signed) {
      return num.fromTwos(this.span * 8).clone();
    }
    return num;
  }

  encode(src: BN, b: Buffer, offset = 0) {
    if (this.signed) {
      src = src.toTwos(this.span * 8);
    }
    return this.blob.encode(src.toArrayLike(Buffer, "le", this.span), b, offset);
  }
}

const u64 = (property?: string) => new BNLayout(8, false, property);

class WrappedLayout<T, U> extends LayoutCls<U> {
  layout: LayoutCls<T>;
  decoder: (data: T) => U;
  encoder: (src: U) => T;

  constructor(
    layout: LayoutCls<T>,
    decoder: (data: T) => U,
    encoder: (src: U) => T,
    property?: string
  ) {
    super(layout.span, property);
    this.layout = layout;
    this.decoder = decoder;
    this.encoder = encoder;
  }

  decode(b: Buffer, offset?: number): U {
    return this.decoder(this.layout.decode(b, offset));
  }

  encode(src: U, b: Buffer, offset?: number): number {
    return this.layout.encode(this.encoder(src), b, offset);
  }

  getSpan(b: Buffer, offset?: number): number {
    return this.layout.getSpan(b, offset);
  }
}

const publicKey = (property?: string) =>
  new WrappedLayout(blob(32), (b: Buffer) => new PublicKey(b), (key: PublicKey) => key.toBuffer(), property);

class OptionLayout<T> extends LayoutCls<T | null> {
  layout: LayoutCls<T>;
  discriminator: ReturnType<typeof u8>;

  constructor(layout: LayoutCls<T>, property?: string) {
    super(-1, property);
    this.layout = layout;
    this.discriminator = u8();
  }

  decode(b: Buffer, offset = 0): T | null {
    const discriminator = this.discriminator.decode(b, offset);
    if (discriminator === 0) return null;
    if (discriminator === 1) return this.layout.decode(b, offset + 1);
    throw new Error("Invalid option");
  }

  encode(src: T | null, b: Buffer, offset = 0): number {
    if (src == null) {
      return this.discriminator.encode(0, b, offset);
    }
    this.discriminator.encode(1, b, offset);
    return this.layout.encode(src, b, offset + 1) + 1;
  }

  getSpan(b: Buffer, offset = 0): number {
    const discriminator = this.discriminator.decode(b, offset);
    if (discriminator === 0) return 1;
    if (discriminator === 1) return this.layout.getSpan(b, offset + 1) + 1;
    throw new Error("Invalid option");
  }
}

const option = <T>(layout: LayoutCls<T>, property?: string) => new OptionLayout(layout, property);

class FutureEpochLayout<T> extends LayoutCls<T | null> {
  layout: LayoutCls<T>;
  discriminator: ReturnType<typeof u8>;

  constructor(layout: LayoutCls<T>, property?: string) {
    super(-1, property);
    this.layout = layout;
    this.discriminator = u8();
  }

  decode(b: Buffer, offset = 0): T | null {
    const discriminator = this.discriminator.decode(b, offset);
    if (discriminator === 0) return null;
    if (discriminator === 1 || discriminator === 2) return this.layout.decode(b, offset + 1);
    throw new Error("Invalid future epoch");
  }

  encode(src: T | null, b: Buffer, offset = 0): number {
    if (src == null) {
      return this.discriminator.encode(0, b, offset);
    }
    this.discriminator.encode(2, b, offset);
    return this.layout.encode(src, b, offset + 1) + 1;
  }

  getSpan(b: Buffer, offset = 0): number {
    const discriminator = this.discriminator.decode(b, offset);
    if (discriminator === 0) return 1;
    if (discriminator === 1 || discriminator === 2) return this.layout.getSpan(b, offset + 1) + 1;
    throw new Error("Invalid future epoch");
  }
}

const futureEpoch = <T>(layout: LayoutCls<T>, property?: string) => new FutureEpochLayout(layout, property);

const feeFields = [u64("denominator"), u64("numerator")];

const StakePoolLayout = struct<StakePoolLayoutDecoded>([
  u8("version"),
  u8("accountType"),
  publicKey("manager"),
  publicKey("staker"),
  publicKey("stakeDepositAuthority"),
  u8("stakeWithdrawBumpSeed"),
  publicKey("validatorList"),
  publicKey("reserveStake"),
  publicKey("poolMint"),
  publicKey("managerFeeAccount"),
  publicKey("tokenProgramId"),
  u64("totalLamports"),
  u64("poolTokenSupply"),
  u64("lastUpdateEpoch"),
  struct([u64("unixTimestamp"), u64("epoch"), publicKey("custodian")], "lockup"),
  struct(feeFields, "epochFee"),
  futureEpoch(struct(feeFields), "nextEpochFee"),
  option(publicKey(), "preferredDepositValidatorVoteAddress"),
  option(publicKey(), "preferredWithdrawValidatorVoteAddress"),
  struct(feeFields, "stakeDepositFee"),
  struct(feeFields, "stakeWithdrawalFee"),
  futureEpoch(struct(feeFields), "nextStakeWithdrawalFee"),
  u8("stakeReferralFee"),
  option(publicKey(), "solDepositAuthority"),
  struct(feeFields, "solDepositFee"),
  u8("solReferralFee"),
  option(publicKey(), "solWithdrawAuthority"),
  struct(feeFields, "solWithdrawalFee"),
  futureEpoch(struct(feeFields), "nextSolWithdrawalFee"),
  u64("lastEpochPoolTokenSupply"),
  u64("lastEpochTotalLamports"),
  option(u64(), "maxValidatorStake"),
]);

export async function fetchRipperStakePool(
  connection: Connection
): Promise<RipperStakePool | null> {
  const account = await connection.getAccountInfo(RIPPER_POOL_ADDRESS, "confirmed");
  if (!account?.data) return null;
  const decoded = StakePoolLayout.decode(account.data);
  return {
    reserveStake: decoded.reserveStake,
    poolMint: decoded.poolMint,
    managerFeeAccount: decoded.managerFeeAccount,
    solDepositAuthority: decoded.solDepositAuthority ?? null,
    totalLamports: BigInt(decoded.totalLamports.toString()),
    poolTokenSupply: BigInt(decoded.poolTokenSupply.toString()),
  };
}

export function findRipperWithdrawAuthority(stakePoolAddress = RIPPER_POOL_ADDRESS) {
  return PublicKey.findProgramAddressSync(
    [stakePoolAddress.toBuffer(), Buffer.from("withdraw")],
    RIPPER_POOL_PROGRAM_ID
  )[0];
}

export function calcPoolTokensForDeposit(stakePool: RipperStakePool, lamports: bigint) {
  if (stakePool.poolTokenSupply === 0n || stakePool.totalLamports === 0n) {
    return lamports;
  }
  return (lamports * stakePool.poolTokenSupply) / stakePool.totalLamports;
}

export function createRipperDepositSolInstruction(params: {
  stakePool: PublicKey;
  withdrawAuthority: PublicKey;
  reserveStake: PublicKey;
  fundingAccount: PublicKey;
  destinationPoolAccount: PublicKey;
  managerFeeAccount: PublicKey;
  referralPoolAccount: PublicKey;
  poolMint: PublicKey;
  lamports: bigint;
  depositAuthority?: PublicKey | null;
}) {
  const data = Buffer.alloc(9);
  data[0] = 14;
  const lamportsBn = new BN(params.lamports.toString());
  lamportsBn.toArrayLike(Buffer, "le", 8).copy(data, 1);
  const keys = [
    { pubkey: params.stakePool, isSigner: false, isWritable: true },
    { pubkey: params.withdrawAuthority, isSigner: false, isWritable: false },
    { pubkey: params.reserveStake, isSigner: false, isWritable: true },
    { pubkey: params.fundingAccount, isSigner: true, isWritable: true },
    { pubkey: params.destinationPoolAccount, isSigner: false, isWritable: true },
    { pubkey: params.managerFeeAccount, isSigner: false, isWritable: true },
    { pubkey: params.referralPoolAccount, isSigner: false, isWritable: true },
    { pubkey: params.poolMint, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
  ];
  if (params.depositAuthority) {
    keys.push({
      pubkey: params.depositAuthority,
      isSigner: true,
      isWritable: false,
    });
  }
  return new TransactionInstruction({
    programId: RIPPER_POOL_PROGRAM_ID,
    keys,
    data,
  });
}
