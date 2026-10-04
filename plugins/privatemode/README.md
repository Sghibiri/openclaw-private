# openclaw-private-privatemode

[Privatemode](https://www.privatemode.ai) (Edgeless Systems, Germany) provider for [OpenClaw Private](https://github.com/sghibiri/openclaw-private), for EU-only installs. Model requests go through a loopback relay that verifies the hardware enclave before every connection; if verification fails, nothing is sent. `openclaw privacy setup` installs it for you.

MIT licensed.
