#!/usr/bin/env bash
set -euo pipefail

# Deploy Anchor program to X1 testnet.
#
# Requirements:
# - Solana CLI at /home/wielop/solana-v1.18.17/bin (or adjust PATH below)
# - Wallet keypair at ~/.config/solana/id.json funded on X1 testnet
# - Network access to https://rpc.testnet.x1.xyz

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

SOLANA_BIN_DIR="${SOLANA_BIN_DIR:-$HOME/solana-v1.18.17/bin}"
RUSTUP_WRAPPER_DIR="$ROOT_DIR/scripts/rustup-wrapper"
# Provide the custom SBF target spec and linker wrapper next in PATH.
SBF_TARGET_DIR="$ROOT_DIR/scripts/sbf-target"
SBF_TARGET_BIN_DIR="$SBF_TARGET_DIR/bin"
export PATH="$SBF_TARGET_BIN_DIR:$PATH"
export RUST_TARGET_PATH="$SBF_TARGET_DIR"
export RUSTUP_TOOLCHAIN="${RUSTUP_TOOLCHAIN:-solana}"
# Wrapper keeps every invocation using our Rust toolchain instead of relinking.
export PATH="$RUSTUP_WRAPPER_DIR:$ROOT_DIR/scripts/cargo-wrapper:$SOLANA_BIN_DIR:$PATH"
export CARGO_NET_OFFLINE=true
export ANCHOR_PROVIDER_URL="https://rpc.testnet.x1.xyz"
export ANCHOR_WALLET="${ANCHOR_WALLET:-$HOME/.config/solana/id.json}"

echo "ANCHOR_PROVIDER_URL=$ANCHOR_PROVIDER_URL"
echo "ANCHOR_WALLET=$ANCHOR_WALLET"

anchor --version

echo "Building..."
anchor build

echo "Deploying..."
anchor deploy --provider.cluster "$ANCHOR_PROVIDER_URL"

echo "Done."
