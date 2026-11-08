# pi-mock-provider

A zero-delay fake provider for [pi](https://github.com/earendil-works/pi).
It answers instantly, in-process — no sockets, no HTTP, no sleep — so any
wall-clock time between your prompt and the reply is **pure framework
overhead**. Compare it against the same prompt on a real provider to see how
much of the delay is the network or the model.

## Install

```sh
pi install git:github.com/hakergeniusz/pi-mock-provider
pi /login mock   # instant fake login, once — stores a credential for pi's auth checks
```

## Models

| Model | Behavior |
| --- | --- |
| `mock/instant` | replies `Mock reply.` immediately |
| `mock/echo` | echoes your last user message (truncated to 200 chars) |

Every turn on a mock model prints the measured **framework delay** — the time
from `agent_start` (pi accepts the prompt) until the assistant message
completes.

## Usage

```sh
# total launch + turn time with a 0ms provider
pi --model mock/instant "hi"

# in the TUI, the notification after each turn shows the framework delay
```

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `PI_MOCK_DELAY_MS` | `0` | artificial delay per event, to simulate a slow provider |
| `PI_MOCK_DEBUG` | — | `1` enables trace logging to stderr |
