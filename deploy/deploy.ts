import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const deployed = await hre.deployments.deploy("SealedSwarmAuction", { from: deployer, log: true });
  console.log(`SealedSwarmAuction: ${deployed.address}`);
};
export default func;
func.id = "deploy_sealedSwarmAuction";
func.tags = ["SealedSwarmAuction"];
