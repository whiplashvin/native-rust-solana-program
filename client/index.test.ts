import { getCreateAccountInstruction } from "@solana-program/system";
import {
  AccountRole,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  generateKeyPairSigner,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";
import { test, describe, expect, beforeAll } from "bun:test";
import { FailedTransactionMetadata, LiteSVM } from "litesvm";

const PROGRAM_PATH = `${import.meta.dir}/../target/deploy/native_rust_solana_program.so`;
const COUNTER_SIZE = 8n;

let svm: LiteSVM;
let programId: Address;
let payer: KeyPairSigner;
let counterAccount: KeyPairSigner;

beforeAll(async () => {
  svm = new LiteSVM();
  programId = (await generateKeyPairSigner()).address;
  payer = await generateKeyPairSigner();
  counterAccount = await generateKeyPairSigner();

  svm.addProgramFromFile(programId, PROGRAM_PATH);
  svm.airdrop(payer.address, lamports(1_000_000_000n));
});

function counterInstruction(data: Uint8Array): Instruction {
  return {
    programAddress: programId,
    accounts: [{ address: counterAccount.address, role: AccountRole.WRITABLE }],
    data,
  };
}

async function sendTx(instructions: Instruction[]) {
  const transaction = await pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayerSigner(payer, tx),
    (tx) => svm.setTransactionMessageLifetimeUsingLatestBlockhash(tx),
    (tx) => appendTransactionMessageInstructions(instructions, tx),
    (tx) => signTransactionMessageWithSigners(tx),
  );
  const result = svm.sendTransaction(transaction);
  if (result instanceof FailedTransactionMetadata) {
    throw new Error(
      `Transaction failed: ${result.err()}\n${result.meta().logs().join("\n")}`,
    );
  }
  svm.expireBlockhash();
  return result;
}

function readCounterValue(): bigint {
  const account = svm.getAccount(counterAccount.address);
  if (!account.exists) throw new Error("counter account not found");
  expect(account.programAddress).toBe(programId);
  return Buffer.from(account.data).readBigUInt64LE(0);
}

function encodeInitCounter(initialValue: bigint): Uint8Array {
  const data = Buffer.alloc(1 + 8);
  data.writeUint8(0, 0);
  data.writeBigUInt64LE(initialValue, 1);
  return data;
}

function encodeIncCounter(): Uint8Array {
  return Buffer.from([1]); // variant 1: IncCounter
}

describe("counter program", () => {
  test("init counter", async () => {
    const createAccountIx = getCreateAccountInstruction({
      payer,
      newAccount: counterAccount,
      lamports: svm.minimumBalanceForRentExemption(COUNTER_SIZE),
      space: COUNTER_SIZE,
      programAddress: programId,
    });

    const initIx = counterInstruction(encodeInitCounter(42n));

    await sendTx([createAccountIx, initIx]);
    expect(readCounterValue()).toBe(42n);
  });

  test("increments the counter", async () => {
    await sendTx([counterInstruction(encodeIncCounter())]);
    expect(readCounterValue()).toBe(43n);
  });

  test("increments repeatedly", async () => {
    for (let i = 0; i < 5; i++) {
      await sendTx([counterInstruction(encodeIncCounter())]);
    }
    expect(readCounterValue()).toBe(48n);
  });

  test("rejects malformed instruction data", async () => {
    const transaction = await pipe(
      createTransactionMessage({ version: 0 }),
      (tx) => setTransactionMessageFeePayerSigner(payer, tx),
      (tx) => svm.setTransactionMessageLifetimeUsingLatestBlockhash(tx),
      (tx) =>
        appendTransactionMessageInstructions(
          [counterInstruction(Buffer.from([9, 9, 9]))],
          tx,
        ),
      (tx) => signTransactionMessageWithSigners(tx),
    );

    const result = svm.sendTransaction(transaction);
    expect(result).toBeInstanceOf(FailedTransactionMetadata);

    // The failed instruction must not corrupt state.
    expect(readCounterValue()).toBe(48n);
  });
});
