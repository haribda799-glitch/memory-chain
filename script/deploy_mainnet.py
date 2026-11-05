"""
script/deploy_mainnet.py — Base Mainnet (Chain ID: 8453) deployment entrypoint.
Delegates to script/deploy.py so both `mox run deploy --network base` and
`mox run deploy_mainnet --network base` execute the full Mainnet deployment & Safe handover.
"""
from script.deploy import deploy


def moccasin_main():
    return deploy()
