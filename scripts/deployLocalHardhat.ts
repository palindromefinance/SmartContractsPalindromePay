import { createPublicClient, createWalletClient, http, WalletClient, Account } from "viem";
import { hardhat } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "fs";

// --- Config ---
const RPC_URL = "http://127.0.0.1:8545";
const DEPLOYER_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";

// --- Load contract artifacts ---
function loadArtifact(path: string) {
    return JSON.parse(readFileSync(path, "utf8"));
}
const EscrowArtifact = loadArtifact("./artifacts/contracts/PalindromeCryptoEscrow.sol/PalindromeCryptoEscrow.json");
const USDTArtifact = loadArtifact("./artifacts/contracts/USDT.sol/USDT.json");

const feeReceiver = process.env.FREE_RECEIVER?.trim()

console.log("---------------------------------------")
console.log(feeReceiver)
console.log("---------------------------------------")

// --- Setup clients ---
const publicClient = createPublicClient({
    chain: hardhat,
    transport: http(RPC_URL),
});

async function deployContract(
    client: WalletClient,
    account: Account,
    { abi, bytecode, args = [] }: { abi: any; bytecode: `0x${string}`; args?: any[] }
) {
    const hash = await client.deployContract({
        abi,
        bytecode,
        args,
        account,
        chain: hardhat,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (!receipt.contractAddress) throw new Error("Deployment failed: No contract address in receipt.");
    return receipt.contractAddress as `0x${string}`;
}

async function main() {
    const deployerAccount = privateKeyToAccount(DEPLOYER_KEY);
    const deployerClient = createWalletClient({
        chain: hardhat,
        transport: http(RPC_URL),
        account: deployerAccount,
    });

    // --- Deploy USDT (name, symbol, initialSupply) ---
    const USDT_INITIAL_SUPPLY = 10_000_000 * 1_000_000; // 10M USDT, 6 decimals
    const usdtAddress = await deployContract(deployerClient, deployerAccount, {
        abi: USDTArtifact.abi,
        bytecode: USDTArtifact.bytecode as `0x${string}`,
        args: ["Tether USD", "USDT", USDT_INITIAL_SUPPLY, 6],
    });

    // --- Deploy Escrow contract, pass LP token + USDT token as constructor args ---
    const escrowAddress = await deployContract(deployerClient, deployerAccount, {
        abi: EscrowArtifact.abi,
        bytecode: EscrowArtifact.bytecode as `0x${string}`,
        args: [feeReceiver],
    });

    console.log(`USDT deployed to:             ${usdtAddress}`);
    console.log(`PalindromeCryptoEscrow to:    ${escrowAddress}`);
}

main().catch((err) => {
    console.error("Deployment error:", err);
    process.exit(1);
});
