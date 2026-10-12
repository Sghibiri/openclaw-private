# openclaw-private

The core of [OpenClaw Private](https://github.com/sghibiri/openclaw-private): an [OpenClaw](https://github.com/openclaw/openclaw) plugin that keeps agents which read your email, logins or documents on a model in a verified hardware enclave or on your own machine.

```bash
openclaw plugins install openclaw-private
openclaw privacy setup
```

It adds a run gate, an egress allowlist proxy, an action policy with approvals, skill approval and a plain-language skill check, the door between your main and private gateways, the `openclaw privacy` commands, and a read-only **Privacy** page in the dashboard sidebar that says who reads your email, on which model, and whether it is protected. See the [project README](https://github.com/sghibiri/openclaw-private#readme).

MIT licensed.
