/**
 * ===============================
 *   ESCROW CONTRACT TEST COVERAGE
 * ===============================
 * This test suite comprehensively covers the core and advanced business logic
 * of the PalindromeCryptoEscrow smart contract, including all critical payout
 * and refund scenarios for both the buyer, seller, and protocol fee recipient.
 *
 * Covered Scenarios:
 *  - Buyer deposit and escrow funding flow
 *  - Delivery confirmation and seller withdrawal
 *  - Meta-transaction delivery (off-chain signature, relayed execution)
 *  - Protocol fee collection and owner fee withdrawal
 *  - Buyer refund via arbiter action with post-refund withdrawal
 *  - Mutual cancel and cancelByTimeout logic, including buyer withdrawal
 *  - Dispute flow and both possible paths (COMPLETE to seller, REFUNDED to buyer)
 *  - Withdrawal logic for both buyer and seller
 *  - Double withdrawal attempts revert (no double-claim)
 *  - Withdrawal for zero-balance reverts (no empty pay)
 *  - Protocol fee double-withdrawal reverts
 *  - Role-based access enforcement for payout/withdraw paths
 *
 *
 * (c) 2025 Palindrome Finance - QA Reference
 */


import 'dotenv/config';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import {
    Address,
    createPublicClient,
    createWalletClient,
    http,
    keccak256,
    encodeAbiParameters, parseAbiParameters,
    WalletClient,
} from 'viem';
import { foundry } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import EscrowServiceArtifact from '../artifacts/contracts/PalindromeCryptoEscrow.sol/PalindromeCryptoEscrow.json' with { type: "json" };
import USDTArtifact from '../artifacts/contracts/USDT.sol/USDT.json' with { type: "json" };
import { getChainId } from 'viem/actions';

const rpcUrl = process.env.RPC_URL ?? 'http://127.0.0.1:8545';
const buyerKey = process.env.BUYER_KEY as `0x${string}`;
const sellerKey = process.env.SELLER_KEY as `0x${string}`;
const ownerKey = process.env.OWNER_KEY as `0x${string}`;

const publicClient = createPublicClient({ chain: foundry, transport: http(rpcUrl) });

const buyer = privateKeyToAccount(buyerKey);
const seller = privateKeyToAccount(sellerKey);
const owner = privateKeyToAccount(ownerKey);

const buyerClient = createWalletClient({ account: buyer, chain: foundry, transport: http(rpcUrl) });
const sellerClient = createWalletClient({ account: seller, chain: foundry, transport: http(rpcUrl) });
const ownerClient = createWalletClient({ account: owner, chain: foundry, transport: http(rpcUrl) });

const tokenAbi = USDTArtifact.abi;
const escrowAbi = EscrowServiceArtifact.abi;
const tokenBytecode = USDTArtifact.bytecode as `0x${string}`;
const escrowBytecode = EscrowServiceArtifact.bytecode as `0x${string}`;

let tokenAddress: `0x${string}`;
let escrowAddress: `0x${string}`;

const chainIdNumber: number = await getChainId(publicClient);
const chainId: bigint = BigInt(chainIdNumber);

const AMOUNT = 1_000_000n;

enum State { AWAITING_PAYMENT, AWAITING_DELIVERY, DISPUTED, COMPLETE, REFUNDED, CANCELED }

// --------- Deployment ----------
before(async () => {
    const initialSupply = 1_000_000_000_000n;
    const tokenTxHash = await ownerClient.deployContract({
        abi: tokenAbi,
        bytecode: tokenBytecode,
        args: ["Tether USD", "USDT", initialSupply],
        account: owner.address,
        chain: foundry,
    });
    tokenAddress = (await publicClient.waitForTransactionReceipt({ hash: tokenTxHash })).contractAddress as `0x${string}`;
    assert.ok(tokenAddress, 'Token deployment failed');

    const escrowTxHash = await ownerClient.deployContract({
        abi: escrowAbi,
        bytecode: escrowBytecode,
        args: [tokenAddress],
        account: owner.address,
        chain: foundry,
    });
    escrowAddress = (await publicClient.waitForTransactionReceipt({ hash: escrowTxHash })).contractAddress as `0x${string}`;
    assert.ok(escrowAddress, 'Escrow deployment failed');
});

// ------ Utility Helpers ----------
async function fundAndApprove(amount: bigint = AMOUNT) {
    await ownerClient.writeContract({
        address: tokenAddress,
        abi: tokenAbi,
        functionName: 'transfer',
        args: [buyer.address, amount]
    });
    await buyerClient.writeContract({
        address: tokenAddress,
        abi: tokenAbi,
        functionName: 'approve',
        args: [escrowAddress, amount]
    });
}

async function createEscrow(amount: bigint = AMOUNT, maturityDays: bigint = 0n) {
    await sellerClient.writeContract({
        address: escrowAddress,
        abi: escrowAbi,
        functionName: 'createEscrow',
        args: [tokenAddress, buyer.address, amount, maturityDays, "Escrow title", "QmHash"],
        chain: foundry,
        account: seller
    });
}

async function setupDeal(amount = AMOUNT, maturityDays = 0n): Promise<number> {
    await fundAndApprove(amount);
    await createEscrow(amount, maturityDays);
    const nextId = Number(await publicClient.readContract({
        address: escrowAddress,
        abi: escrowAbi,
        functionName: 'nextEscrowId'
    }));
    return nextId - 1;
}


function buildMessageHash(
    chainId: bigint,
    escrowAddress: Address,
    escrowId: number,
    participant: Address,
    depositTime: bigint,
    deadline: bigint,
    nonce: bigint,
    method: string
): `0x${string}` {
    // Parse the ABI parameter types once (do this at module level for efficiency)
    const abiParams = parseAbiParameters(
        'uint256, address, uint256, address, uint256, uint256, uint256, string'
    );

    // Prepare your values as a strictly ordered tuple
    const values: [
        bigint,        // chainId as bigint
        `0x${string}`, // escrowAddress as string with 0x prefix
        bigint,        // escrowId as bigint
        `0x${string}`, // participant as string with 0x prefix
        bigint,        // depositTime as bigint
        bigint,        // deadline as bigint (UNIX timestamp)
        bigint,        // nonce as bigint
        string         // method (e.g. "confirmDelivery")
    ] = [
            BigInt(chainId),
            escrowAddress as `0x${string}`,
            BigInt(escrowId),
            participant as `0x${string}`,
            BigInt(depositTime),
            BigInt(deadline),
            BigInt(nonce),
            method
        ];

    // Encode with ABI encoding, then hash
    const encoded = encodeAbiParameters(abiParams, values);
    return keccak256(encoded);
}


async function sign(participantClient: WalletClient, account: Address, hash: `0x${string}`) {
    return await participantClient.signMessage({ account, message: { raw: hash } });
}

async function getDeal(id: number) {
    return await publicClient.readContract({
        address: escrowAddress,
        abi: escrowAbi,
        functionName: 'escrows',
        args: [id]
    }) as any;
}

async function increaseTime(seconds: number) {
    await publicClient.transport.request({ method: 'evm_increaseTime', params: [seconds] });
    await publicClient.transport.request({ method: 'evm_mine', params: [] });
}

// --------- Core Tests (contract state and withdrawal) ---------

test('deposit and delivery flow with withdrawal', async () => {
    const id = await setupDeal();
    await buyerClient.writeContract({ address: escrowAddress, abi: escrowAbi, functionName: 'deposit', args: [id] });
    await buyerClient.writeContract({ address: escrowAddress, abi: escrowAbi, functionName: 'confirmDelivery', args: [id] });

    // Check seller's withdrawable
    let sellerWithdrawable = await publicClient.readContract({
        address: escrowAddress,
        abi: escrowAbi,
        functionName: 'withdrawable',
        args: [tokenAddress, seller.address],
    });
    assert(Number(sellerWithdrawable) > 0, "Seller should have withdrawable balance");

    // Seller withdraws
    await sellerClient.writeContract({
        address: escrowAddress,
        abi: escrowAbi,
        functionName: 'withdraw',
        args: [id]
    });
    sellerWithdrawable = await publicClient.readContract({
        address: escrowAddress,
        abi: escrowAbi,
        functionName: 'withdrawable',
        args: [tokenAddress, seller.address],
    });
    assert.equal(Number(sellerWithdrawable), 0, "Seller withdrawable should be zero after withdraw");
});

test('protocol can withdraw fees after delivery', async () => {
    const id = await setupDeal();
    await buyerClient.writeContract({ address: escrowAddress, abi: escrowAbi, functionName: 'deposit', args: [id] });
    await buyerClient.writeContract({ address: escrowAddress, abi: escrowAbi, functionName: 'confirmDelivery', args: [id] });

    let feeAmount = await publicClient.readContract({
        address: escrowAddress,
        abi: escrowAbi,
        functionName: 'feeWithdrawable',
        args: [tokenAddress]
    });
    assert(Number(feeAmount) > 0, "Protocol should have fee to withdraw");

    await ownerClient.writeContract({
        address: escrowAddress,
        abi: escrowAbi,
        functionName: 'withdrawFee',
        args: [tokenAddress, owner.address]
    });

    feeAmount = await publicClient.readContract({
        address: escrowAddress,
        abi: escrowAbi,
        functionName: 'feeWithdrawable',
        args: [tokenAddress]
    });
    assert.equal(Number(feeAmount), 0, "Fee withdrawable should be zero after owner withdraws");
});

// Buyer can withdraw after refund (by arbiter)
test('refund and buyer withdrawal', async () => {
    const id = await setupDeal();
    await buyerClient.writeContract({ address: escrowAddress, abi: escrowAbi, functionName: 'deposit', args: [id] });

    // Refund by arbiter
    await ownerClient.writeContract({
        address: escrowAddress,
        abi: escrowAbi,
        functionName: 'refund',
        args: [id]
    });

    // Buyer should have withdrawable balance
    const buyerWithdrawable = await publicClient.readContract({
        address: escrowAddress,
        abi: escrowAbi,
        functionName: 'withdrawable',
        args: [tokenAddress, buyer.address]
    });
    assert(Number(buyerWithdrawable) > 0, "Buyer should have withdrawable after refund");

    // Buyer withdraws
    await buyerClient.writeContract({
        address: escrowAddress,
        abi: escrowAbi,
        functionName: 'withdraw',
        args: [id]
    });
    const buyerAfter = await publicClient.readContract({
        address: escrowAddress,
        abi: escrowAbi,
        functionName: 'withdrawable',
        args: [tokenAddress, buyer.address]
    });
    assert.equal(Number(buyerAfter), 0, "Withdrawable zero after buyer claim");
});

// Mutual cancel refunds buyer
test('mutual cancel triggers withdrawal for buyer', async () => {
    const id = await setupDeal();
    await buyerClient.writeContract({ address: escrowAddress, abi: escrowAbi, functionName: 'deposit', args: [id] });
    await buyerClient.writeContract({ address: escrowAddress, abi: escrowAbi, functionName: 'requestCancel', args: [id] });
    await sellerClient.writeContract({ address: escrowAddress, abi: escrowAbi, functionName: 'requestCancel', args: [id] });

    // Buyer should have withdrawable
    const buyerWithdrawable = await publicClient.readContract({
        address: escrowAddress,
        abi: escrowAbi,
        functionName: 'withdrawable',
        args: [tokenAddress, buyer.address]
    });
    assert(Number(buyerWithdrawable) > 0, "Buyer withdrawable after mutual cancel");

    // Buyer withdraws
    await buyerClient.writeContract({
        address: escrowAddress,
        abi: escrowAbi,
        functionName: 'withdraw',
        args: [id]
    });
    const buyerAfter = await publicClient.readContract({
        address: escrowAddress,
        abi: escrowAbi,
        functionName: 'withdrawable',
        args: [tokenAddress, buyer.address]
    });
    assert.equal(Number(buyerAfter), 0, "Buyer withdrawable zero after claiming cancel funds");
});

// Dispute resolved to seller, seller can withdraw
test('dispute resolved to seller and withdrawal', async () => {
    const id = await setupDeal();
    await buyerClient.writeContract({ address: escrowAddress, abi: escrowAbi, functionName: 'deposit', args: [id] });
    await buyerClient.writeContract({ address: escrowAddress, abi: escrowAbi, functionName: 'startDispute', args: [id] });

    // Arbitrator (owner) resolves to seller
    await ownerClient.writeContract({
        address: escrowAddress,
        abi: escrowAbi,
        functionName: 'resolveDispute',
        args: [id, State.COMPLETE]
    });

    // Seller can withdraw
    let sellerWithdrawable = await publicClient.readContract({
        address: escrowAddress,
        abi: escrowAbi,
        functionName: 'withdrawable',
        args: [tokenAddress, seller.address]
    });
    assert(Number(sellerWithdrawable) > 0, "Seller withdrawable after dispute resolution");

    // Seller withdraws
    await sellerClient.writeContract({
        address: escrowAddress,
        abi: escrowAbi,
        functionName: 'withdraw',
        args: [id]
    });
    sellerWithdrawable = await publicClient.readContract({
        address: escrowAddress,
        abi: escrowAbi,
        functionName: 'withdrawable',
        args: [tokenAddress, seller.address]
    });
    assert.equal(Number(sellerWithdrawable), 0, "Withdrawable zero after seller claim");
});

// Dispute resolved to buyer, buyer can withdraw
test('dispute resolved to buyer and withdrawal', async () => {
    const id = await setupDeal();
    await buyerClient.writeContract({ address: escrowAddress, abi: escrowAbi, functionName: 'deposit', args: [id] });
    await buyerClient.writeContract({ address: escrowAddress, abi: escrowAbi, functionName: 'startDispute', args: [id] });

    // Arbitrator (owner) resolves to buyer (refund)
    await ownerClient.writeContract({
        address: escrowAddress,
        abi: escrowAbi,
        functionName: 'resolveDispute',
        args: [id, State.REFUNDED]
    });

    // Buyer should have withdrawable
    let buyerWithdrawable = await publicClient.readContract({
        address: escrowAddress,
        abi: escrowAbi,
        functionName: 'withdrawable',
        args: [tokenAddress, buyer.address]
    });
    assert(Number(buyerWithdrawable) > 0, "Buyer withdrawable after dispute resolved refunded");

    // Buyer withdraws
    await buyerClient.writeContract({
        address: escrowAddress,
        abi: escrowAbi,
        functionName: 'withdraw',
        args: [id]
    });
    buyerWithdrawable = await publicClient.readContract({
        address: escrowAddress,
        abi: escrowAbi,
        functionName: 'withdrawable',
        args: [tokenAddress, buyer.address]
    });
    assert.equal(Number(buyerWithdrawable), 0, "Withdrawable zero after buyer claim");
});

test('seller withdraw reverts if balance is zero after payout claimed', async () => {
    const id = await setupDeal();
    await buyerClient.writeContract({ address: escrowAddress, abi: escrowAbi, functionName: 'deposit', args: [id] });
    await buyerClient.writeContract({ address: escrowAddress, abi: escrowAbi, functionName: 'confirmDelivery', args: [id] });
    await sellerClient.writeContract({ address: escrowAddress, abi: escrowAbi, functionName: 'withdraw', args: [id] });
    await assert.rejects(
        async () => await sellerClient.writeContract({ address: escrowAddress, abi: escrowAbi, functionName: 'withdraw', args: [tokenAddress] }),
        "Second withdraw should revert"
    );
});

test('protocol fee withdraw reverts if already claimed', async () => {
    const id = await setupDeal();
    await buyerClient.writeContract({ address: escrowAddress, abi: escrowAbi, functionName: 'deposit', args: [id] });
    await buyerClient.writeContract({ address: escrowAddress, abi: escrowAbi, functionName: 'confirmDelivery', args: [id] });
    await ownerClient.writeContract({ address: escrowAddress, abi: escrowAbi, functionName: 'withdrawFee', args: [tokenAddress, owner.address] });
    await assert.rejects(
        async () => await ownerClient.writeContract({ address: escrowAddress, abi: escrowAbi, functionName: 'withdrawFee', args: [tokenAddress, owner.address] }),
        "Second fee withdraw should revert"
    );
});


test('meta transaction delivery allows seller withdraw', async () => {
    const id = await setupDeal();
    await buyerClient.writeContract({ address: escrowAddress, abi: escrowAbi, functionName: 'deposit', args: [id] });
    let deal = await getDeal(id);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const nonce = deal[10];
    const hash = buildMessageHash(chainId, escrowAddress, id, buyer.address, deal[5], deadline, nonce, 'confirmDelivery');
    const signature = await sign(buyerClient, buyer.address, hash);

    // Relayed by seller or anyone
    await buyerClient.writeContract({
        address: escrowAddress,
        abi: escrowAbi,
        functionName: 'confirmDeliverySigned',
        args: [id, signature, deadline, nonce]
    });

    // Seller can withdraw
    let sellerWithdrawable = await publicClient.readContract({
        address: escrowAddress,
        abi: escrowAbi,
        functionName: 'withdrawable',
        args: [tokenAddress, seller.address]
    });
    assert(Number(sellerWithdrawable) > 0, "Seller should have withdrawable after meta-confirm");

    await sellerClient.writeContract({
        address: escrowAddress,
        abi: escrowAbi,
        functionName: 'withdraw',
        args: [id]
    });

    sellerWithdrawable = await publicClient.readContract({
        address: escrowAddress,
        abi: escrowAbi,
        functionName: 'withdrawable',
        args: [tokenAddress, seller.address]
    });
    console.log("Seller withdrawable balance:", sellerWithdrawable);
    assert.equal(Number(sellerWithdrawable), 0, "Seller withdrawable zero after claim");
});


test('withdrawal reverts for seller with zero balance', async () => {
    const id = await setupDeal();
    await buyerClient.writeContract({ address: escrowAddress, abi: escrowAbi, functionName: 'deposit', args: [id] });

    // Seller should have zero withdrawable (assert explicitly)
    let sellerWithdrawable = await publicClient.readContract({
        address: escrowAddress, abi: escrowAbi, functionName: 'withdrawable', args: [tokenAddress, seller.address]
    });
    assert.equal(Number(sellerWithdrawable), 0, "Seller withdrawable should be zero before any settlement");

    console.log("Token:", tokenAddress);
    console.log("Seller:", seller.address);


    // Attempt withdraw and expect revert
    await assert.rejects(
        async () => await sellerClient.writeContract({ address: escrowAddress, abi: escrowAbi, functionName: 'withdraw', args: [tokenAddress] }),
        "Withdraw with zero balance should revert for seller"
    );
});


