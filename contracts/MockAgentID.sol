// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
contract MockAgentID {
    mapping(address => uint256) public balanceOf;
    function set(address who, uint256 amount) external { balanceOf[who] = amount; }
}
