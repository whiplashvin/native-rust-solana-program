import {
  generateKeyPairSigner,
  lamports,
  createTransactionMessage,
  setTransactionMessageFeePayerSigner,
  appendTransactionMessageInstructions,
  signTransactionMessageWithSigners,
  pipe,
  type Address,
  type KeyPairSigner,
  createKeyPairFromBytes,
  getStructDecoder,
  getBooleanDecoder,
  getAddressDecoder,
  getU64Decoder,
  getU64Encoder,
  AccountRole,
  address,
  getProgramDerivedAddress,
} from "@solana/kit";
import { getCreateAccountInstruction } from "@solana-program/system";
import {
  TOKEN_PROGRAM_ADDRESS,
  getMintSize,
  getInitializeMint2Instruction,
  getCreateAssociatedTokenInstruction,
  findAssociatedTokenPda,
  getMintToInstruction,
  getTokenDecoder,
  getTransferInstruction,
  getTokenSize,
  getInitializeAccount3Instruction,
  getAccountStateDecoder,
} from "@solana-program/token";
import { describe, test, expect, beforeAll } from "bun:test";
import { LiteSVM, FailedTransactionMetadata } from "litesvm";

// 0. `[signer]` The account of the person initializing the escrow
// 1. `[writable]` Temporary token account that should be created prior to this instruction and owned by the initializer
// 2. `[]` The initializer's token account for the token they will receive should the trade go through
// 3. `[writable]` The escrow account, it will hold all necessary info about the trade.
// 4. `[]` The rent sysvar
// 5. `[]` The token program

let svm: LiteSVM;
let programId: Address;
let initializer: KeyPairSigner;
let mintX: KeyPairSigner;
let mintY: KeyPairSigner;
let initializerTokenXAcc: Address;
let initializerTokenYAcc: Address;
let initializerTempTokenXAcc: KeyPairSigner;
let escrowAcc: KeyPairSigner;

beforeAll(async () => {
  svm = new LiteSVM();
  programId = (await generateKeyPairSigner()).address;
  initializer = await generateKeyPairSigner();
  initializerTempTokenXAcc = await generateKeyPairSigner();
  escrowAcc = await generateKeyPairSigner();
  svm.airdrop(initializer.address, lamports(10_000_000_000n));

  mintX = await generateKeyPairSigner();
  mintY = await generateKeyPairSigner();
  const space = BigInt(getMintSize()); // 82 bytes
  const tokenAccSpace = BigInt(getTokenSize());
  const escrowStateSpace = 105n;
  const rent = svm.minimumBalanceForRentExemption(space);
  const rentForTokAcc = svm.minimumBalanceForRentExemption(tokenAccSpace);
  const rentForEscrowAcc = svm.minimumBalanceForRentExemption(escrowStateSpace);

  const createMintAccountIx = getCreateAccountInstruction({
    payer: initializer,
    newAccount: mintX,
    lamports: lamports(rent),
    space,
    programAddress: TOKEN_PROGRAM_ADDRESS,
  });

  const initMintIx = getInitializeMint2Instruction({
    mint: mintX.address,
    decimals: 9,
    mintAuthority: initializer.address,
    freezeAuthority: null,
  });

  const [initializerTokenX] = await findAssociatedTokenPda({
    owner: initializer.address,
    mint: mintX.address,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  initializerTokenXAcc = initializerTokenX;

  const tokenXAccIx = getCreateAssociatedTokenInstruction({
    payer: initializer,
    ata: initializerTokenXAcc,
    owner: initializer.address,
    mint: mintX.address,
  });

  const mintXToAtaIx = getMintToInstruction({
    mint: mintX.address,
    token: initializerTokenXAcc,
    mintAuthority: initializer,
    amount: 100n,
  });

  const createMintYAccountIx = getCreateAccountInstruction({
    payer: initializer,
    newAccount: mintY,
    lamports: lamports(rent),
    space,
    programAddress: TOKEN_PROGRAM_ADDRESS,
  });

  const initMintYIx = getInitializeMint2Instruction({
    mint: mintY.address,
    decimals: 9,
    mintAuthority: initializer.address,
    freezeAuthority: null,
  });

  const [initializerTokenY] = await findAssociatedTokenPda({
    owner: initializer.address,
    mint: mintY.address,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  initializerTokenYAcc = initializerTokenY;

  const tokenYAccIx = getCreateAssociatedTokenInstruction({
    payer: initializer,
    ata: initializerTokenYAcc,
    owner: initializer.address,
    mint: mintY.address,
  });

  const createInitializerTempAccountIx = getCreateAccountInstruction({
    payer: initializer,
    newAccount: initializerTempTokenXAcc,
    lamports: lamports(rentForTokAcc),
    space: tokenAccSpace,
    programAddress: TOKEN_PROGRAM_ADDRESS,
  });

  const initTempAccountIx = getInitializeAccount3Instruction({
    account: initializerTempTokenXAcc.address,
    mint: mintX.address,
    owner: initializer.address,
  });

  const transferXtoTempIx = getTransferInstruction({
    source: initializerTokenXAcc,
    destination: initializerTempTokenXAcc.address,
    authority: initializer,
    amount: 100n,
  });

  const createEscorwIx = getCreateAccountInstruction({
    payer: initializer,
    newAccount: escrowAcc,
    lamports: lamports(rentForEscrowAcc),
    space: escrowStateSpace,
    programAddress: programId,
  });

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(initializer, m),
    (m) => svm.setTransactionMessageLifetimeUsingLatestBlockhash(m),
    (m) =>
      appendTransactionMessageInstructions(
        [
          createMintAccountIx,
          initMintIx,
          tokenXAccIx,
          mintXToAtaIx,
          createMintYAccountIx,
          initMintYIx,
          tokenYAccIx,
          createInitializerTempAccountIx,
          initTempAccountIx,
          transferXtoTempIx,
          createEscorwIx,
        ],
        m,
      ),
  );

  const signedTx = await signTransactionMessageWithSigners(message);
  const result = svm.sendTransaction(signedTx);

  if (result instanceof FailedTransactionMetadata) {
    throw new Error(result.err().toString());
  }
});

test("mint X is created and owned by the token program", () => {
  const mintAccount = svm.getAccount(mintX.address);
  expect(mintAccount.exists).toBe(true);
  if (mintAccount.exists) {
    expect(mintAccount.programAddress).toBe(TOKEN_PROGRAM_ADDRESS);
    expect(mintAccount.data.length).toBe(getMintSize());
  }
});

test("check ata", () => {
  const mintAccount = svm.getAccount(mintX.address);
  const ata = svm.getAccount(initializerTokenXAcc);
  expect(ata.exists).toBe(true);
  if (!ata.exists) return;
  const decoded = getTokenDecoder().decode(ata.data);
  expect(decoded.mint).toBe(mintAccount.address);
  expect(decoded.owner).toBe(initializer.address);
  expect(decoded.amount).toBe(0n);
});

test("check temp X token account", () => {
  const mintAccount = svm.getAccount(mintX.address);
  const temp = svm.getAccount(initializerTempTokenXAcc.address);
  expect(temp.exists).toBe(true);
  if (!temp.exists) return;
  const decoded = getTokenDecoder().decode(temp.data);
  expect(decoded.mint).toBe(mintAccount.address);
  expect(decoded.owner).toBe(initializer.address);
  expect(decoded.amount).toBe(100n);
});

test("create escrow account", () => {
  let escrowAccount = svm.getAccount(escrowAcc.address);
  expect(escrowAccount.exists).toBe(true);
  if (!escrowAccount.exists) return;
  const escrowDecoder = getStructDecoder([
    ["isInitialized", getBooleanDecoder()],
    ["initializerPubkey", getAddressDecoder()],
    ["tempTokenAccountPubkey", getAddressDecoder()],
    ["initializerTokenToReceiveAccountPubkey", getAddressDecoder()],
    ["expectedAmount", getU64Decoder()],
  ]);
  const decoded = escrowDecoder.decode(escrowAccount.data);
});

test("initEscrow", async () => {
  svm.addProgramFromFile(programId, "../target/deploy/escrow_v2.so");
  const RENT_SYSVAR = address("SysvarRent111111111111111111111111111111111");
  const expectedAmount = 50n;
  const data = new Uint8Array([0, ...getU64Encoder().encode(expectedAmount)]);
  const initEscrowIx = {
    programAddress: programId,
    accounts: [
      { address: initializer.address, role: AccountRole.READONLY_SIGNER },
      { address: initializerTempTokenXAcc.address, role: AccountRole.WRITABLE },
      { address: initializerTokenYAcc, role: AccountRole.READONLY },
      { address: escrowAcc.address, role: AccountRole.WRITABLE },
      { address: RENT_SYSVAR, role: AccountRole.READONLY },
      { address: TOKEN_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ],
    data,
  };

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(initializer, m),
    (m) => svm.setTransactionMessageLifetimeUsingLatestBlockhash(m),
    (m) => appendTransactionMessageInstructions([initEscrowIx], m),
  );

  const signedTx = await signTransactionMessageWithSigners(message);
  const result = svm.sendTransaction(signedTx);
  if (result instanceof FailedTransactionMetadata) {
    throw new Error(result.err().toString());
  }

  const escrowAccount = svm.getAccount(escrowAcc.address);
  expect(escrowAccount.exists).toBe(true);
  if (!escrowAccount.exists) return;

  const escrowDecoder = getStructDecoder([
    ["isInitialized", getBooleanDecoder()],
    ["initializerPubkey", getAddressDecoder()],
    ["tempTokenAccountPubkey", getAddressDecoder()],
    ["initializerTokenToReceiveAccountPubkey", getAddressDecoder()],
    ["expectedAmount", getU64Decoder()],
  ]);
  const escrow = escrowDecoder.decode(escrowAccount.data);
  console.log(escrow);
  expect(escrow.isInitialized).toBe(true);
  expect(escrow.initializerPubkey).toBe(initializer.address);
  expect(escrow.tempTokenAccountPubkey).toBe(initializerTempTokenXAcc.address);
  expect(escrow.initializerTokenToReceiveAccountPubkey).toBe(
    initializerTokenYAcc,
  );
  expect(escrow.expectedAmount).toBe(expectedAmount);

  const [escrowPda] = await getProgramDerivedAddress({
    programAddress: programId,
    seeds: [new TextEncoder().encode("escrow")],
  });

  const temp = svm.getAccount(initializerTempTokenXAcc.address);

  expect(temp.exists).toBe(true);
  if (!temp.exists) return;
  const tempDecoded = getTokenDecoder().decode(temp.data);
  expect(tempDecoded.owner).toBe(escrowPda);
  expect(tempDecoded.amount).toBe(100n);
});
