# QQ Bot for OpenClaw

This repository is a maintained fork of the QQ Bot channel plugin for OpenClaw. It connects the official QQ Bot API to OpenClaw and carries a set of fixes around multi-account support, voice config, prompt hygiene, media flows, and message delivery behavior.

This README documents the behavior of **this fork**, not necessarily the current upstream npm release.

## What this fork changes

- supports `channels.qqbot.accounts.default` as the default account
- supports account-scoped `STT/TTS`
- removes the old per-message prompt-heavy QQ rule injection
- trims QQ media / cron skill text to reduce context pollution
- persists lightweight pending inbound history
- adds IM-style short split replies with pacing controls
- hardens `QQBOT_PAYLOAD` handling and avoids leaking internal protocol text to end users

## Typical use cases

- remote-control OpenClaw via QQ direct messages or groups
- run multiple QQ bots in one OpenClaw instance
- bind different bots to different agents
- configure different `STT/TTS` per bot
- send images, voice, video, and files

## Install

### From your fork or local source

```bash
git clone <your-fork-url>
cd qqbot
openclaw plugins install .
```

### From a local packed tarball

```bash
npm pack
openclaw plugins install ./van4622-qqbot-1.5.4-van.1.tgz
```

For remote servers, deploying a `.tgz` package is usually the safest path.

### From a GitHub Release asset

Download the release asset from your fork, then install it:

```bash
curl -L -o qqbot.tgz <your-release-asset-url>
openclaw plugins install ./qqbot.tgz
```

## Config shape

This fork expects the standard multi-account layout:

```json
{
  "channels": {
    "qqbot": {
      "enabled": true,
      "stt": {
        "provider": "siliconflow",
        "model": "FunAudioLLM/SenseVoiceSmall"
      },
      "accounts": {
        "default": {
          "enabled": true,
          "allowFrom": ["*"],
          "appId": "1903058177",
          "clientSecret": "your-default-secret"
        },
        "huajin": {
          "enabled": true,
          "allowFrom": ["*"],
          "appId": "1903057687",
          "clientSecret": "your-huajin-secret"
        }
      }
    }
  }
}
```

Notes:

- `accounts.default` is the default bot account
- named accounts go under `accounts.<accountId>`
- top-level `channels.qqbot` is mainly for plugin-wide defaults

## Binding bots to agents

Typical routing:

```json
{
  "bindings": [
    {
      "agentId": "main",
      "match": {
        "channel": "qqbot",
        "accountId": "default"
      }
    },
    {
      "agentId": "huajin",
      "match": {
        "channel": "qqbot",
        "accountId": "huajin"
      }
    }
  ]
}
```

## Voice configuration

### STT priority

1. `channels.qqbot.accounts.<accountId>.stt`
2. `channels.qqbot.stt`
3. `tools.media.audio.models[0]`

### TTS priority

1. `channels.qqbot.accounts.<accountId>.tts`
2. `channels.qqbot.tts`
3. `messages.tts`

### Example

```json
{
  "channels": {
    "qqbot": {
      "stt": {
        "provider": "siliconflow",
        "model": "FunAudioLLM/SenseVoiceSmall"
      },
      "accounts": {
        "default": {
          "appId": "1903058177",
          "clientSecret": "secret-a",
          "tts": {
            "provider": "siliconflow",
            "baseUrl": "https://api.siliconflow.cn/v1",
            "apiKey": "key-a",
            "model": "FunAudioLLM/CosyVoice2-0.5B",
            "voice": "FunAudioLLM/CosyVoice2-0.5B:alex"
          }
        },
        "huajin": {
          "appId": "1903057687",
          "clientSecret": "secret-b",
          "tts": {
            "provider": "siliconflow",
            "baseUrl": "https://api.siliconflow.cn/v1",
            "apiKey": "key-b",
            "model": "FunAudioLLM/CosyVoice2-0.5B",
            "voice": "speech:huajin:example"
          }
        }
      }
    }
  }
}
```

## Media sending rules

### Send existing media files directly

- image: `<qqimg>/absolute/path/or/url</qqimg>`
- voice: `<qqvoice>/absolute/path</qqvoice>`
- video: `<qqvideo>/absolute/path/or/url</qqvideo>`
- file: `<qqfile>/absolute/path/or/url</qqfile>`

### Use built-in TTS to turn text into a voice message

Use `QQBOT_PAYLOAD`:

```text
QQBOT_PAYLOAD:
{
  "type": "media",
  "mediaType": "audio",
  "source": "file",
  "path": "This text should be turned into voice and sent."
}
```

Important:

- the entire reply must be only this payload
- `QQBOT_PAYLOAD:` must be on the first line
- do not add explanation text before or after it

See [docs/qqbot-media-guide.md](docs/qqbot-media-guide.md) for the practical media rules.

## IM-style short split replies

This fork can split longer passive plain-text replies into multiple short messages for a more natural IM feel.

### Priority

1. `channels.qqbot.accounts.<accountId>.imStyleReply`
2. `channels.qqbot.imStyleReply`

### Supported fields

- `enabled`
- `minLength`
- `maxParts`
- `targetPartLength`
- `maxPartLength`
- `delayMs`
- `delayMinMs`
- `delayMaxMs`

If both `delayMs` and `delayMinMs/delayMaxMs` are set, the delay range wins.

### Example

```json
{
  "channels": {
    "qqbot": {
      "accounts": {
        "huajin": {
          "appId": "1903057687",
          "clientSecret": "secret-b",
          "imStyleReply": {
            "enabled": true,
            "minLength": 18,
            "maxParts": 4,
            "targetPartLength": 28,
            "maxPartLength": 64,
            "delayMinMs": 500,
            "delayMaxMs": 1100
          }
        }
      }
    }
  }
}
```

Notes:

- only applies to passive plain-text replies
- does not split `<qqimg>` / `<qqvoice>` / `<qqvideo>` / `<qqfile>` / `QQBOT_PAYLOAD`
- code blocks, lists, headings, and blockquotes are left unsplit

## Running locally without a public IP

QQ control still works without a public IP as long as your local machine can make outbound connections to:

- the QQ Bot gateway
- your model / `STT` / `TTS` providers

That does **not** mean your Control UI is reachable from the public internet. For the dashboard you still need:

- SSH tunneling
- Tailscale / ZeroTier
- a reverse proxy / NAT traversal setup

## Known behavior

- `STT` is automatic in the plugin; the model receives the transcript result
- `TTS` is an active reply path; the model must choose `<qqvoice>` or `QQBOT_PAYLOAD`
- malformed `QQBOT_PAYLOAD` is logged and suppressed instead of being sent to users
- passive replies are still subject to platform-side message reply limits

## Troubleshooting

### Account is configured but receives no messages

Run the gateway in the foreground:

```bash
openclaw gateway stop
openclaw gateway run --verbose
```

Typical causes:

- `invalid appid or secret`
- missing QQ platform permissions
- the account never reaches `READY`

### `clientSecret` became `"__OPENCLAW_REDACTED__"`

If the value on disk is literally `"__OPENCLAW_REDACTED__"`, that is not display-only masking. The credential has been overwritten and must be replaced with the real secret manually.

### IM-style config seems ignored

Make sure you deployed the latest packaged build of this fork, not an older `.tgz`.

## License

This fork continues to use the upstream [MIT License](LICENSE).

Keep the original license and copyright notice.
