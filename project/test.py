from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
import gradio as gr
import os
import ast
import inspect
import pandas as pd

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

latest_blockly_code = ""
stored_api_key = ""  # Store the OpenAI API key in memory
stored_hf_key = ""  # Store the Hugging Face API key in memory


# Gets REAL Python code, not the LLM DSL
@app.post("/update_code")
async def update_code(request: Request):
    global latest_blockly_code
    data = await request.json()
    latest_blockly_code = data.get("code", "")
    return {"ok": True}

# Sends the latest code to chat.py so that the agent will be able to use the MCP
@app.get("/get_latest_code")
async def get_latest_code():
    global latest_blockly_code
    return {"code": latest_blockly_code}

@app.get("/get_api_key")
async def get_api_key_endpoint():
    global stored_api_key, stored_hf_key
    api_key = stored_api_key or os.environ.get("OPENAI_API_KEY", "")
    hf_key = stored_hf_key or os.environ.get("HUGGINGFACE_API_KEY", "")
    
    # Mask the API keys for security (show only first 7 and last 4 characters)
    if api_key and len(api_key) > 15:
        masked_api_key = api_key[:7] + '...' + api_key[-4:]
    else:
        masked_api_key = api_key if api_key else ""
    
    if hf_key and len(hf_key) > 15:
        masked_hf_key = hf_key[:7] + '...' + hf_key[-4:]
    else:
        masked_hf_key = hf_key if hf_key else ""
    
    return {"api_key": masked_api_key, "hf_key": masked_hf_key}

@app.post("/set_api_key")
async def set_api_key_endpoint(request: Request):
    global stored_api_key, stored_hf_key
    data = await request.json()
    api_key = data.get("api_key", "").strip()
    hf_key = data.get("hf_key", "").strip()
    
    try:
        # Store in memory and set environment variables
        if api_key:
            stored_api_key = api_key
            os.environ["OPENAI_API_KEY"] = api_key
            print(f"[API KEY] Set OPENAI_API_KEY in environment")
        
        if hf_key:
            stored_hf_key = hf_key
            os.environ["HUGGINGFACE_API_KEY"] = hf_key
            print(f"[HF KEY] Set HUGGINGFACE_API_KEY in environment")
        
        return {"success": True}
    except Exception as e:
        print(f"Error setting API keys: {e}")
        return {"success": False, "error": str(e)}


def execute_blockly_logic(user_inputs):
    global latest_blockly_code, stored_api_key
    if not latest_blockly_code.strip():
        return "No Blockly code available"

    # Ensure API key is set in environment before executing
    if stored_api_key:
        os.environ["OPENAI_API_KEY"] = stored_api_key

    result = ""

    # More comprehensive filtering of Gradio-related code
    lines = latest_blockly_code.split('\n')
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

    def capture_result(msg):
        nonlocal result
        result = msg

    # Set up the environment with necessary imports that might be needed
    env = {
        "reply": capture_result,
        "__builtins__": __builtins__,
    }

    try:
        # Import any required modules in the execution environment
        exec("import os", env)
        exec(code_to_run, env)
        if "create_mcp" in env:
            sig = inspect.signature(env["create_mcp"])
            params = list(sig.parameters.values())

            typed_args = []
            for i, arg in enumerate(user_inputs):
                if i >= len(params):
                    break
                if arg is None or arg == "":
                    typed_args.append(None)
                    continue

                anno = params[i].annotation
                try:
                    if anno == int:
                        typed_args.append(int(arg))
                    elif anno == float:
                        typed_args.append(float(arg))
                    elif anno == bool:
                        # Handle boolean conversion from string (checkbox in Gradio sends True/False)
                        if isinstance(arg, bool):
                            typed_args.append(arg)
                        else:
                            typed_args.append(str(arg).lower() in ("true", "1"))
                    elif anno == list:
                        try:
                            # Convert string like '["a", "b", "c"]' into an actual list
                            typed_args.append(ast.literal_eval(arg))
                        except Exception:
                            # If parsing fails, wrap it as a single-item list
                            typed_args.append([arg])
                    elif anno == str or anno == inspect._empty:
                        typed_args.append(str(arg))
                    else:
                        # Handle remaining type cases
                        typed_args.append(arg)
                except ValueError:
                    # If type conversion fails, try to coerce intelligently
                    if anno == float:
                        try:
                            typed_args.append(float(arg))
                        except Exception:
                            typed_args.append(arg)
                    elif anno == int:
                        try:
                            typed_args.append(int(float(arg)))  # Allow "3.5" to become 3
                        except Exception:
                            typed_args.append(arg)
                    else:
                        typed_args.append(arg)
                except Exception:
                    # If conversion fails, pass the raw input
                    typed_args.append(arg)

            if len(typed_args) > 0 and isinstance(typed_args[0], list):
                typed_args[0] = pd.DataFrame(typed_args[0])

            result = env["create_mcp"](*typed_args)
        elif "process_input" in env:
            env["process_input"](user_inputs)
    except Exception as e:
        print("[EXECUTION ERROR]", e)
        result = f"Error: {str(e)}"

    return result if result is not None and result != "" else "No output generated"


def build_interface():
    with gr.Blocks(title="Test MCP Server") as demo:
        # Create a fixed number of potential input fields (max 10)
        input_fields = []
        input_labels = []
        input_group_items = []
        
        with gr.Accordion("MCP Inputs", open=True):
            for i in range(10):
                # Create inputs that can be shown/hidden
                txt = gr.Textbox(label=f"Input {i+1}", visible="hidden")
                input_fields.append(txt)
                input_group_items.append(txt)

        output_fields = []
        
        with gr.Accordion("MCP Outputs", open=True):
            for i in range(10):
                out = gr.Textbox(label=f"Output {i+1}", visible="hidden", interactive=False)
                output_fields.append(out)
        
        with gr.Row():
            submit_btn = gr.Button("Test")
            refresh_btn = gr.Button("Refresh")

        def refresh_inputs():
            global latest_blockly_code
            import re

            # Look for the create_mcp function definition
            pattern = r'def create_mcp\((.*?)\):'
            match = re.search(pattern, latest_blockly_code)

            params = []
            if match:
                params_str = match.group(1)
                if params_str.strip():
                    # Parse parameters to extract names and types
                    for param in params_str.split(','):
                        param = param.strip()
                        if ':' in param:
                            name, type_hint = param.split(':')
                            type_hint = type_hint.strip()
                            # Convert Python type hints to display names
                            if 'int' in type_hint:
                                display_type = 'integer'
                            elif 'float' in type_hint:
                                display_type = 'float'
                            elif 'list' in type_hint:
                                display_type = 'list'
                            elif 'bool' in type_hint:
                                display_type = 'boolean'
                            else:
                                display_type = 'string'
                            params.append({
                                'name': name.strip(),
                                'type': display_type
                            })
                        else:
                            params.append({
                                'name': param,
                                'type': 'string'
                            })

            # Detect output count (out_amt = N)
            out_amt_match = re.search(r'out_amt\s*=\s*(\d+)', latest_blockly_code)
            out_amt = int(out_amt_match.group(1)) if out_amt_match else 0

            out_names_match = re.search(r'out_names\s*=\s*(\[.*?\])', latest_blockly_code, re.DOTALL)
            if out_names_match:
                try:
                    out_names = ast.literal_eval(out_names_match.group(1))
                except Exception:
                    out_names = []
            else:
                out_names = []

            out_types_match = re.search(r'out_types\s*=\s*(\[.*?\])', latest_blockly_code, re.DOTALL)
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
                    output_updates.append(gr.Textbox(visible=True, label=f"{out_names[i]} ({out_types[i]})", value=""))
                else:
                    output_updates.append(gr.Textbox(visible="hidden", value=""))

            # Update visibility + clear input fields
            updates = []
            for i, field in enumerate(input_fields):
                if i < len(params):
                    param = params[i]
                    note = ""
                    if param["type"] == "list":
                        note = "- (use like: [\"a\", \"b\", ...])"

                    updates.append(gr.Textbox(
                        visible=True,
                        label=f"{param['name']} ({param['type']}) {note}",
                        value=""
                    ))
                else:
                    updates.append(gr.Textbox(visible="hidden", value=""))

            return updates + output_updates

        def process_input(*args):
            result = execute_blockly_logic(args)

            # Get output types to determine how to format the result
            import re
            out_types_match = re.search(r'out_types\s*=\s*(\[.*?\])', latest_blockly_code, re.DOTALL)
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
            outputs=input_fields + output_fields,
            queue=False
        )
        
        submit_btn.click(
            process_input,
            inputs=input_fields,
            outputs=output_fields,
            queue=False
        )

    return demo


def get_gradio_interface():
    return build_interface()


if __name__ == "__main__":
    demo = build_interface()
    app = gr.mount_gradio_app(app, demo, path="/")