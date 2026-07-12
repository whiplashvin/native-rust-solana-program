use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{
    account_info::{AccountInfo, next_account_info}, 
    entrypoint,
    entrypoint::{ ProgramResult}, 
    program_error, pubkey::Pubkey
};

use crate::CounterInstructions::{IncCounter, InitCounter};

entrypoint!(process_instruction);

#[derive(BorshSerialize,BorshDeserialize)]
struct Counter {
    value: u64
}

#[derive(BorshDeserialize)]
enum CounterInstructions {
    InitCounter {initial_value: u64},
    IncCounter
}

fn process_instruction(
    _program_id: &Pubkey,
    accounts: &[AccountInfo],
    instructions: &[u8]
)->ProgramResult{
    let instructions = CounterInstructions::try_from_slice(instructions).map_err(|_| program_error::INVALID_INSTRUCTION_DATA)?;

    match instructions {
        InitCounter {initial_value} => {
            process_init(accounts, initial_value)?;
        },
        IncCounter => {
            process_inc(accounts)?;
        }
    }
    Ok(())
}

fn process_init(
    accounts: &[AccountInfo],
    initial_value: u64,
)->ProgramResult{
    let accounts_iter = &mut accounts.iter();
    let counter_account = next_account_info(accounts_iter)?;

    let new_counter = Counter{
        value: initial_value
    };

    let mut data = &mut counter_account.data.borrow_mut()[..];
    new_counter.serialize(&mut data)?;
    Ok(())
}

fn process_inc(
    accounts: &[AccountInfo]
)->ProgramResult{
    let accounts_iter = &mut accounts.iter();
    let counter_account = next_account_info(accounts_iter)?;

    let mut counter_data = Counter::try_from_slice(&mut counter_account.data.borrow_mut()[..])?;
    counter_data.value = counter_data.value + 1;
    counter_data.serialize(&mut &mut counter_account.data.borrow_mut()[..])?;
    Ok(())
}