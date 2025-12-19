from fastapi import FastAPI, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import gradio as gr
import os
import ast
import inspect
import pandas as pd
import multiprocessing
import time
from collections import defaultdict
import uuid
import logging

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Per-session storage for the latest Blockly-generated code
latest_blockly_code = defaultdict(str)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("test_app")

# ---------------------------------------------------------------------------
# Session helpers
# ---------------------------------------------------------------------------

def require_session_id(data_or_query):
    """
    Ensure every request carries a session_id; otherwise reject.
    """
    session_id = None
    if isinstance(data_or_query, dict):
        session_id = data_or_query.get("session_id")
    else:
        session_id = data_or_query

    if not session_id:
        raise HTTPException(status_code=400, detail="session_id is required")
    return session_id


# ---------------------------------------------------------------------------
# Safe execution helpers (protect against infinite loops and crashes)
# ---------------------------------------------------------------------------

def _worker_exec(code_str, inputs, queue, openai_key=None, hf_key=None):
    """
    Execute user-generated code in an isolated process.
    Returns output through a queue to avoid sharing state.
    """
    try:
        # Inject keys into environment for this process only (not persisted outside)
        if openai_key:
            os.environ["OPENAI_API_KEY"] = openai_key
        if hf_key:
            os.environ["HF_TOKEN"] = hf_key

        result = ""

        def capture_result(msg):
            nonlocal result
            result = msg

        # Execution environment
        env = {
            "reply": capture_result,
            "__builtins__": __builtins__,
        }

        # Minimal imports that Blockly outputs may rely on
        exec("import os\nimport pandas as pd\nimport ast\nimport inspect", env)

        exec(code_str, env)
        if "create_mcp" in env:
            func = env["create_mcp"]
            sig = inspect.signature(func)
            params = list(sig.parameters.values())
            in_types = getattr(func, "in_types", [])

            typed_args = []
            for i, arg in enumerate(inputs):
                if i >= len(params):
                    break
                if arg is None or arg == "":
                    typed_args.append(None)
                    continue

                target_type = in_types[i] if i < len(in_types) else params[i].annotation
                try:
                    if target_type in (int, "int", "integer"):
                        typed_args.append(int(arg))
                    elif target_type in (float, "float"):
                        typed_args.append(float(arg))
                    elif target_type in (bool, "bool", "boolean"):
                        typed_args.append(bool(arg) if isinstance(arg, bool) else str(arg).lower() in ("true", "1", "yes"))
                    elif target_type in (list, "list"):
                        if isinstance(arg, list):
                            typed_args.append(arg)
                        else:
                            try:
                                typed_args.append(ast.literal_eval(arg))
                            except Exception:
                                typed_args.append([arg])
                    elif target_type in ("any", "Any"):
                        typed_args.append(arg)
                    elif target_type == inspect._empty:
                        typed_args.append(str(arg))
                    else:
                        typed_args.append(str(arg))
                except Exception:
                    typed_args.append(arg)

            if len(typed_args) > 0 and isinstance(typed_args[0], list):
                typed_args[0] = pd.DataFrame(typed_args[0])

            result = env["create_mcp"](*typed_args)
        elif "process_input" in env:
            env["process_input"](inputs)

        queue.put({"ok": True, "result": result if result not in (None, "") else "No output generated"})
    except Exception as e:
        queue.put({"ok": False, "result": f"Error: {str(e)}"})


# ---------------------------------------------------------------------------
# API endpoints
# ---------------------------------------------------------------------------

# Gets REAL Python code, not the LLM DSL
@app.post("/update_code")
async def update_code(request: Request):
    data = await request.json()
    session_id = require_session_id(data)
    latest_blockly_code[session_id] = data.get("code", "")
    logger.info(f"[update_code] Stored code; length={len(latest_blockly_code[session_id])}")
    return {"ok": True}

# Sends the latest code to chat.py so that the agent will be able to use the MCP
@app.get("/get_latest_code")
async def get_latest_code(request: Request):
    session_id = require_session_id(dict(session_id=request.query_params.get("session_id")))
    logger.info(f"[get_latest_code] Returning code; length={len(latest_blockly_code.get(session_id, ''))}")
    return {"code": latest_blockly_code.get(session_id, "")}

def execute_blockly_logic(user_inputs, session_id, openai_key=None, hf_key=None):
    """
    Execute the Blockly-generated code for a specific session in an isolated, timed subprocess.
    """
    if not session_id:
        return "No session_id provided to execute code."
    logger.info(f"[execute_blockly_logic] executing; inputs={user_inputs}")
    code_for_session = latest_blockly_code.get(session_id, "")
    if not code_for_session.strip():
        return "No Blockly code available"

    # Strip Gradio scaffolding before execution
    lines = code_for_session.split('\n')
    filtered_lines = []
    skip_mode = False
    in_demo_block = False
    
    for line in lines:
        # Skip import gradio line
        if 'import gradio' in line:
            continue
            
        # Skip Gradio interface creation and any demo-related lines
        if 'demo = gr.Interface' in line:
            in_demo_block = True
            skip_mode = True
            continue
        elif 'demo.launch' in line:
            skip_mode = False
            in_demo_block = False
            continue
        elif in_demo_block:
            # Skip everything in the demo block (multi-line Interface declaration)
            continue
            
        # Skip any standalone gr. calls
        if 'gr.' in line:
            continue
        
        if not skip_mode:
            filtered_lines.append(line)
    
    code_to_run = '\n'.join(filtered_lines)
    # Launch in isolated subprocess
    q = multiprocessing.Queue()
    p = multiprocessing.Process(target=_worker_exec, args=(code_to_run, user_inputs, q, openai_key, hf_key), daemon=True)
    p.start()
    p.join(timeout=8)

    if p.is_alive():
        p.terminate()
        p.join()
        logger.error("[execute_blockly_logic] timeout")
        return "Error: Execution timed out"

    if q.empty():
        return "No output generated"

    msg = q.get()
    return msg.get("result", "No output generated")


def build_interface():
    with gr.Blocks(title="Test MCP Server") as demo:
        session_state = gr.State()

        def init_session(req: gr.Request):
            sid = None
            q_sid = None
            c_sid = None
            try:
                q_sid = req.query_params.get("session_id")
            except Exception:
                q_sid = None
            try:
                c_sid = req.cookies.get("mcp_blockly_session_id")
            except Exception:
                c_sid = None

            sid = q_sid or c_sid
            logger.info("[init_session] session resolved")
            if not sid:
                logger.error("Gradio test interface loaded without session_id (neither query param nor cookie); refresh/process will be no-ops.")
            return sid

        demo.load(init_session, inputs=None, outputs=[session_state], queue=False)

        def hide_all_fields():
            # Hide everything after initial mount so they don't flash visible
            return [gr.update(visible=False, value="") for _ in input_fields + output_fields]

        # Create a fixed number of potential input fields (max 10)
        input_fields = []
        input_labels = []
        input_group_items = []
        
        with gr.Accordion("MCP Inputs", open=True):
            for i in range(10):
                # Create inputs that can be shown/hidden
                # Gradio 6 lazy-renders hidden components; start visible so they mount, then hide via refresh updates
                txt = gr.Textbox(label=f"Input {i+1}", visible=True)
                input_fields.append(txt)
                input_group_items.append(txt)

        output_fields = []
        
        with gr.Accordion("MCP Outputs", open=True):
            for i in range(10):
                # Start visible to force mount; refresh updates will hide/show appropriately
                out = gr.Textbox(label=f"Output {i+1}", visible=True, interactive=False)
                output_fields.append(out)
        
        with gr.Row():
            submit_btn = gr.Button("Test")
            refresh_btn = gr.Button("Refresh")

        def refresh_inputs(session_id):
            if not session_id:
                logger.error("refresh_inputs called without session_id; no data will be returned.")
                return [gr.update(visible=False, value="") for _ in input_fields + output_fields]
            import re
            code_str = latest_blockly_code.get(session_id, "")
            logger.info(f"[refresh_inputs] code length={len(code_str)}")

            def normalize_type_name(type_name):
                if not type_name:
                    return "string"
                if isinstance(type_name, str):
                    type_name_lower = type_name.lower()
                    if "int" in type_name_lower:
                        return "integer"
                    if "float" in type_name_lower:
                        return "float"
                    if "list" in type_name_lower:
                        return "list"
                    if "bool" in type_name_lower:
                        return "boolean"
                    if "any" in type_name_lower:
                        return "any"
                return "string"

            # Look for the create_mcp function definition
            # Allow multiline function signatures
            pattern = r'def\s+create_mcp\s*\((.*?)\)\s*:'
            match = re.search(pattern, code_str, re.DOTALL)

            params = []
            # Prefer explicit in_types if present
            in_types_match = re.search(r'in_types\s*=\s*(\[.*?\])', code_str, re.DOTALL)
            in_types = []
            if in_types_match:
                try:
                    in_types = ast.literal_eval(in_types_match.group(1))
                except Exception:
                    in_types = []

            if match:
                params_str = match.group(1)
                if params_str.strip():
                    # Parse parameters to extract names and types
                    for idx, param in enumerate(params_str.split(',')):
                        param = param.strip()
                        name = param.split(':')[0].strip() if param else param
                        # Prefer in_types entry, fall back to annotation parsing
                        display_type = normalize_type_name(in_types[idx] if idx < len(in_types) else None)
                        if ':' in param and (not in_types or idx >= len(in_types)):
                            _, type_hint = param.split(':')
                            display_type = normalize_type_name(type_hint.strip())

                        params.append({
                            'name': name,
                            'type': display_type
                        })

            # Detect output count (out_amt = N)
            out_amt_match = re.search(r'out_amt\s*=\s*(\d+)', code_str)
            out_amt = int(out_amt_match.group(1)) if out_amt_match else 0

            out_names_match = re.search(r'out_names\s*=\s*(\[.*?\])', code_str, re.DOTALL)
            if out_names_match:
                try:
                    out_names = ast.literal_eval(out_names_match.group(1))
                except Exception:
                    out_names = []
            else:
                out_names = []

            out_types_match = re.search(r'out_types\s*=\s*(\[.*?\])', code_str, re.DOTALL)
            if out_types_match:
                try:
                    out_types = ast.literal_eval(out_types_match.group(1))
                except Exception:
                    out_types = []
            else:
                out_types = []
            # Convert output types: handle string, integer, float, list, boolean, any
            out_types = [
                "string" if t == "str" else 
                "integer" if t == "int" else 
                "float" if t == "float" else 
                "list" if t == "list" else 
                "boolean" if t == "bool" else 
                "any" if t == "Any" else t 
                for t in out_types
            ]

            # Update visibility + clear output fields
            output_updates = []
            for i, field in enumerate(output_fields):
                if i < out_amt:
                    output_updates.append(gr.update(visible=True, label=f"{out_names[i]} ({out_types[i]})", value=""))
                else:
                    output_updates.append(gr.update(visible=False, value=""))

            # Update visibility + clear input fields
            updates = []
            for i, field in enumerate(input_fields):
                if i < len(params):
                    param = params[i]
                    note = ""
                    if param["type"] == "list":
                        note = "- (use like: [\"a\", \"b\", ...])"

                    updates.append(gr.update(
                        visible=True,
                        label=f"{param['name']} ({param['type']}) {note}",
                        value=""
                    ))
                else:
                    updates.append(gr.update(visible=False, value=""))

            return updates + output_updates

        def process_input(*args, request: gr.Request = None):
            *inputs, session_id = args
            if not session_id:
                logger.error("process_input called without session_id; aborting.")
                return [""] * 10

            openai_key = None
            hf_key = None
            if request:
                openai_key = request.headers.get("x-openai-key") or request.cookies.get("mcp_openai_key")
                hf_key = request.headers.get("x-hf-key") or request.cookies.get("mcp_hf_key")

            result = execute_blockly_logic(inputs, session_id, openai_key=openai_key, hf_key=hf_key)

            # Get output types to determine how to format the result
            import re
            code_str = latest_blockly_code.get(session_id, "")
            out_types_match = re.search(r'out_types\s*=\s*(\[.*?\])', code_str, re.DOTALL)
            out_types = []
            if out_types_match:
                try:
                    out_types = ast.literal_eval(out_types_match.group(1))
                    # Convert Python type strings to display names
                    out_types = [
                        "string" if t == "str" else 
                        "integer" if t == "int" else 
                        "float" if t == "float" else 
                        "list" if t == "list" else 
                        "boolean" if t == "bool" else 
                        "any" if t == "Any" else t 
                        for t in out_types
                    ]
                except Exception:
                    out_types = []

            # If result is a tuple or list
            if isinstance(result, (tuple, list)):
                # Check if the first output type is "list" or "any" - if so, convert to string representation
                if out_types and out_types[0] in ("list", "any"):
                    return [str(result)] + [""] * 9
                else:
                    # Multiple outputs - each item is a separate output
                    return list(result) + [""] * (10 - len(result))
            
            # If it's a single value, put it in the first slot and pad the rest
            return [result] + [""] * 9

        # When refresh is clicked, update input field visibility and labels
        refresh_btn.click(
            refresh_inputs,
            inputs=[session_state],
            outputs=input_fields + output_fields,
            queue=False
        )
        
        submit_btn.click(
            process_input,
            inputs=input_fields + [session_state],
            outputs=output_fields,
            queue=False
        )

        # After mount, hide all fields so they don't stay visible until refreshed
        demo.load(
            hide_all_fields,
            inputs=None,
            outputs=input_fields + output_fields,
            queue=False
        )

    return demo


def get_gradio_interface():
    return build_interface()


if __name__ == "__main__":
    demo = build_interface()
    app = gr.mount_gradio_app(app, demo, path="/")
