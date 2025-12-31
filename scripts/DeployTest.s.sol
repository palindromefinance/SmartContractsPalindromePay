// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

// ./scripts/deployTestFoundry.sh base-test pk
// ./scripts/deployTestFoundry.sh bsc-test pk

import "forge-std/Script.sol";
import "../contracts/PalindromeCryptoEscrow.sol";
import "../contracts/USDT.sol";

/// @title DeployTestEscrow
/// @notice Deploys both test USDT token and PalindromeCryptoEscrow for testnet environments
contract DeployTestEscrow is Script {
    function run() external {
        // Load fee receiver from environment
        address feeReceiver = vm.envAddress("FEE_RECEIVER");
        require(feeReceiver != address(0), "FEE_RECEIVER not set");

        console.log("Deploying Test USDT and PalindromeCryptoEscrow...");
        console.log("Fee Receiver:", feeReceiver);

        vm.startBroadcast();

        // Deploy test USDT with 1 million supply (6 decimals like real USDT)
        USDT usdt = new USDT(
            "Test USDT",
            "USDT",
            10_000_000 * 10**6,  // 1 million USDT
            6                   // 6 decimals like real USDT
        );

        // Deploy escrow contract
        PalindromeCryptoEscrow escrow = new PalindromeCryptoEscrow(feeReceiver);

        vm.stopBroadcast();

        console.log("========== Deployment Complete ==========");
        console.log("Test USDT:", address(usdt));
        console.log("PalindromeCryptoEscrow:", address(escrow));
        console.log("Fee Receiver:", feeReceiver);
        console.log("=========================================");
    }
}
