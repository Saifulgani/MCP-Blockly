# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

All commands run from `project/`:

```bash
# Install dependencies (one-time setup)
pip install -r ../requirements.txt
npm install

# Build frontend + start server
npm start

# Build frontend only (webpack production build)
npm run build

# Start server without rebuilding
python unified_server.py
```

The server starts on `http://127.0.0.1:8080` by default. The `PORT` environment variable overrides this.

## Architecture

### Directory Layout

```
mcp-blockly/
├── requirements.txt          # Python deps (FastAPI, Gradio 6, OpenAI, HuggingFace)
└── project/
    ├── unified_server.py     # Main FastAPI entry point
    ├── chat.py               # AI assistant backend
    ├── test.py               # Testing panel backend
    ├── webpack.config.js     # Bundles src/ → dist/bundle.js
    └── src/
        ├── index.js          # Blockly workspace initialization
        ├── toolbox.js        # Block category/toolbox configuration
        ├── serialization.js  # Workspace save/load
        ├── blocks/text.js    # Custom block definitions
        └── generators/
            ├── python.js     # Real Python code generator
            └── chat.js       # AI DSL generator (workspace → text for AI)
```

### Dual Code Generation

Every workspace change triggers **two generators**:

1. **`generators/python.js`** → Executable Python code sent to `test.py` via `POST /update_code`
2. **`generators/chat.js`** → AI DSL representation sent with chat messages to `chat.py`

The Python generator produces a `create_mcp()` function that always includes metadata the testing backend parses:
```python
def create_mcp(param1: str, param2: int):
  out_amt = 1
  out_names = ["result"]
  out_types = ["str"]
  # body...
  return result
```

The chat generator produces a DSL format using `↿ blockId ↾ blockType(inputs(...))`. Block IDs are the Blockly-assigned UUIDs used by the AI to target specific blocks for create/delete/replace operations.

### Unified Server (`unified_server.py`)

A single FastAPI app that:
- Serves the built frontend from `dist/`
- Routes API endpoints to `chat.py` and `test.py`
- Mounts two Gradio apps: `/gradio-test` and `/gradio-chat`

### Testing Backend (`test.py`)

- Stores latest generated code in memory (`latest_blockly_code`)
- `POST /update_code` — frontend pushes new Python code on every block change
- `GET /get_latest_code` — used by `chat.py` so AI can call the user's MCP tool
- Gradio interface at `/gradio-test` dynamically builds input fields by parsing the `create_mcp()` signature; "Refresh" re-reads parameter types/names from `out_amt`, `out_names`, `out_types` metadata in the code
- Executes user code via `exec()` in a sandboxed env dict, then calls `create_mcp(*typed_args)`

### AI Assistant Backend (`chat.py`)

- OpenAI API (gpt-4.1 or similar) with SSE streaming via `GET /unified_stream`
- `POST /update_chat` — sends workspace DSL + user message to AI
- `POST /request_result` — frontend posts results of block operations (create/delete/variable) back to Python; matched by `request_id` from a queue
- Two queues coordinate Python↔JS: `requests_queue` (Py→JS instructions) and `results_queue` (JS→Py confirmations)
- `POST /set_api_key_chat` — stores OpenAI + HuggingFace keys in memory and env vars
- HuggingFace deployment: packages generated `app.py` and uploads to HF Spaces via `huggingface_hub`

### Frontend (`src/index.js`)

- Blockly workspace uses the Zelos renderer with a dark theme
- One permanent non-deletable `create_mcp` block is always on the canvas
- On every workspace change, two code generations run: Python (→ `POST /update_code`) and Chat DSL (stored for next AI message)
- AI responses come back as SSE events containing JSON instructions for block operations the frontend executes directly on the workspace

### Custom Block Types

Defined in `src/blocks/text.js`, generators in `src/generators/python.js`:
- `create_mcp` — the root MCP function block (always present, non-deletable)
- `func_def` / `func_call` — user-defined functions
- `llm_call` — calls an LLM with a prompt
- `call_api` — HTTP requests
- `in_json` / `make_json` — JSON extraction and construction
- `lists_contains`, `cast_as` — utility blocks

Standard Blockly blocks (logic, loops, math, text, lists, variables) are used as-is.
