import os
import re
import requests
from fastapi import FastAPI, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from openai import OpenAI
import gradio as gr
import asyncio
import queue
import json
import uuid
import time
from colorama import Fore, Style
import logging
from huggingface_hub import HfApi
from collections import defaultdict
from typing import Dict, Any

# ---------------------------------------------------------------------------
# Session-local stores (no shared global state across users)
# ---------------------------------------------------------------------------

# Per-session queues for all block operation requests (Py -> JS)
requests_queues = defaultdict(queue.Queue)

# Per-session queues for all request results from frontend (JS -> Py)
results_queues = defaultdict(queue.Queue)

# Per-session latest Blockly chat code + variables
session_chat_state: Dict[str, Dict[str, str]] = defaultdict(lambda: {"code": "", "vars": ""})

# Per-session deployment status
session_deploy_state: Dict[str, Dict[str, Any]] = defaultdict(lambda: {
    "current_mcp_server_url": None,
    "deployment_just_happened": False,
    "deployment_message": None,
})

# Default placeholders to avoid accidental global reuse of secrets
api_key = None
client = None
first_output_block_attempted = False


def require_session_id(data_or_query) -> str:
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


def redact_secrets(text: str) -> str:
    """
    Best-effort redaction of obvious API key formats before logging.
    """
    if not text:
        return text
    return re.sub(r"(sk-[A-Za-z0-9]{20,})", "***", re.sub(r"(hf_[A-Za-z0-9]{20,})", "***", text))

# Helper function to wait for a result from the per-session queue
def wait_for_result(request_id, request_type, session_id, timeout=8, id_field='request_id'):
    session_id = require_session_id(session_id)
    start_time = time.time()
    check_interval = 0.05
    results_buffer = []  # Buffer for results we read but don't match
    results_queue = results_queues[session_id]
    
    while time.time() - start_time < timeout:
        # Check if we have buffered results that match
        for i, result in enumerate(results_buffer):
            if (result.get(id_field) == request_id and 
                result.get('request_type') == request_type):
                results_buffer.pop(i)
                return result
        
        # Try to get a new result from queue
        try:
            result = results_queue.get_nowait()
            # Check if this is our result
            if (result.get(id_field) == request_id and 
                result.get('request_type') == request_type):
                # Put back any buffered results we collected
                for buffered in results_buffer:
                    results_queue.put(buffered)
                results_buffer = []
                return result
            else:
                # Not our result, buffer it for other functions to find
                results_buffer.append(result)
        except queue.Empty:
            pass
        
        time.sleep(check_interval)
    
    # Timeout - put back any buffered results
    for buffered in results_buffer:
        results_queue.put(buffered)
    
    raise TimeoutError(f"No response received for {request_type} request {request_id} after {timeout} seconds")

blocks_context = ""
try:
    file_path = os.path.join(os.path.dirname(__file__), "blocks.txt")
    with open(file_path, "r", encoding="utf-8") as f:
        blocks_context = f.read().strip()
except Exception as e:
    print(f"[WARN] Could not read blocks.txt: {e}")
    blocks_context = "(No external block data available.)"

# FastAPI App
app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.post("/update_chat")
async def update_chat(request: Request):
    data = await request.json()
    session_id = require_session_id(data)
    session_chat_state[session_id]["code"] = data.get("code", "")
    session_chat_state[session_id]["vars"] = data.get("varString", "")
    return {"code": session_chat_state[session_id]["code"]}


def delete_block(block_id, session_id):
    try:
        session_id = require_session_id(session_id)
        print(f"[DELETE REQUEST] Attempting to delete block: {block_id}")
        
        # Add to unified requests queue
        delete_data = {"type": "delete", "block_id": block_id}
        requests_queues[session_id].put(delete_data)
        print(f"[DELETE REQUEST] Added to queue: {block_id}")
        
        # Wait for result from unified queue (delete uses 'block_id' as the identifier field)
        try:
            result = wait_for_result(block_id, "delete", session_id, timeout=8, id_field='block_id')
            print(f"[DELETE RESULT] Received result for {block_id}: success={result.get('success')}, error={result.get('error')}")
            if result["success"]:
                return f"[TOOL] Successfully deleted block {block_id}"
            else:
                return f"[TOOL] Failed to delete block {block_id}: {result.get('error', 'Unknown error')}"
        except TimeoutError as e:
            print(f"[DELETE TIMEOUT] {e}")
            return f"Timeout waiting for deletion confirmation for block {block_id}"
            
    except Exception as e:
        print(f"[DELETE ERROR] {e}")
        import traceback
        traceback.print_exc()
        return f"Error deleting block: {str(e)}"

def create_block(block_spec, blockID=None, placement_type=None, input_name=None, session_id=None):
    try:
        session_id = require_session_id(session_id)
        # Generate a unique request ID
        request_id = str(uuid.uuid4())
        
        # Add to creation queue with optional blockID, placement_type, and input_name
        queue_data = {"type": "create", "request_id": request_id, "block_spec": block_spec}
        if blockID:
            queue_data["blockID"] = blockID
        if placement_type:
            queue_data["placement_type"] = placement_type
        if input_name:
            queue_data["input_name"] = input_name
        requests_queues[session_id].put(queue_data)
        
        # Wait for result from unified queue
        try:
            result = wait_for_result(request_id, "create", session_id, timeout=8)
            if result["success"]:
                return f"[TOOL] Successfully created block: {result.get('block_id', 'unknown')}"
            else:
                error_msg = result.get('error') or 'Unknown error'
                return f"[TOOL] Failed to create block: {error_msg}"
        except TimeoutError as e:
            print(f"[CREATE TIMEOUT] {e}")
            return f"Timeout waiting for block creation confirmation"
            
    except Exception as e:
        print(f"[CREATE ERROR] {e}")
        import traceback
        traceback.print_exc()
        return f"Error creating block: {str(e)}"

def create_variable(var_name, session_id):
    try:
        session_id = require_session_id(session_id)
        print(f"[VARIABLE REQUEST] Attempting to create variable: {var_name}")
        
        # Generate a unique request ID
        request_id = str(uuid.uuid4())
        
        # Add to variable creation queue
        queue_data = {"type": "variable", "request_id": request_id, "variable_name": var_name}
        requests_queues[session_id].put(queue_data)
        print(f"[VARIABLE REQUEST] Added to queue with ID: {request_id}")
        
        # Wait for result from unified queue
        try:
            result = wait_for_result(request_id, "variable", session_id, timeout=8)
            print(f"[VARIABLE RESULT] Received result for {request_id}: success={result.get('success')}, error={result.get('error')}")
            if result["success"]:
                return f"[TOOL] Successfully created variable: {result.get('variable_id', var_name)}"
            else:
                return f"[TOOL] Failed to create variable: {result.get('error', 'Unknown error')}"
        except TimeoutError as e:
            print(f"[VARIABLE TIMEOUT] {e}")
            return f"Timeout waiting for variable creation confirmation"
            
    except Exception as e:
        print(f"[VARIABLE ERROR] {e}")
        import traceback
        traceback.print_exc()
        return f"Error creating variable: {str(e)}"

def edit_mcp(inputs=None, outputs=None, session_id=None):
    try:
        session_id = require_session_id(session_id)
        print(f"[EDIT MCP REQUEST] Attempting to edit MCP block: inputs={inputs}, outputs={outputs}")
        
        # Generate a unique request ID
        request_id = str(uuid.uuid4())
        
        # Build the edit data
        edit_data = {"type": "edit_mcp", "request_id": request_id}
        if inputs is not None:
            edit_data["inputs"] = inputs
        if outputs is not None:
            edit_data["outputs"] = outputs
        
        # Add to edit MCP queue
        requests_queues[session_id].put(edit_data)
        print(f"[EDIT MCP REQUEST] Added to queue with ID: {request_id}")
        
        # Wait for result from unified queue
        try:
            result = wait_for_result(request_id, "edit_mcp", session_id, timeout=8)
            print(f"[EDIT MCP RESULT] Received result for {request_id}: success={result.get('success')}, error={result.get('error')}")
            if result["success"]:
                return f"[TOOL] Successfully edited MCP block inputs/outputs"
            else:
                return f"[TOOL] Failed to edit MCP block: {result.get('error', 'Unknown error')}"
        except TimeoutError as e:
            print(f"[EDIT MCP TIMEOUT] {e}")
            return f"Timeout waiting for MCP edit confirmation"
            
    except Exception as e:
        print(f"[EDIT MCP ERROR] {e}")
        import traceback
        traceback.print_exc()
        return f"Error editing MCP block: {str(e)}"

def replace_block(block_id, command, session_id):
    try:
        session_id = require_session_id(session_id)
        print(f"[REPLACE REQUEST] Attempting to replace block {block_id} with: {command}")
        
        # Check if trying to replace create_mcp block
        if command.strip().startswith("create_mcp("):
            error_msg = "[TOOL] Cannot replace the create_mcp block. The main MCP block cannot be replaced. You can only edit its inputs/outputs using the edit_mcp tool."
            print(f"[REPLACE BLOCKED] Attempt to replace create_mcp block blocked: {error_msg}")
            return error_msg
        
        # Generate a unique request ID
        request_id = str(uuid.uuid4())
        
        # Build the replace data
        replace_data = {"type": "replace", "request_id": request_id, "block_id": block_id, "block_spec": command}
        
        # Add to replace block queue
        requests_queues[session_id].put(replace_data)
        print(f"[REPLACE REQUEST] Added to queue with ID: {request_id}")
        
        # Wait for result from unified queue
        try:
            result = wait_for_result(request_id, "replace", session_id, timeout=8)
            print(f"[REPLACE RESULT] Received result for {request_id}: success={result.get('success')}, error={result.get('error')}")
            if result["success"]:
                return f"[TOOL] Successfully replaced block {block_id}"
            else:
                return f"[TOOL] Failed to replace block: {result.get('error', 'Unknown error')}"
        except TimeoutError as e:
            print(f"[REPLACE TIMEOUT] {e}")
            return f"Timeout waiting for block replacement confirmation"
            
    except Exception as e:
        print(f"[REPLACE ERROR] {e}")
        import traceback
        traceback.print_exc()
        return f"Error replacing block: {str(e)}"

# Unified Server-Sent Events endpoint for all workspace operations
@app.get("/unified_stream")
async def unified_stream(session_id: str = None, request: Request = None):
    # Diagnostics before enforcing session
    q_sid = None
    c_sid = None
    hdr_sid = None
    root_path = None
    try:
        if request:
            q_sid = request.query_params.get("session_id")
            c_sid = request.cookies.get("mcp_blockly_session_id")
            hdr_sid = request.headers.get("x-session-id") or request.headers.get("session-id")
            root_path = request.scope.get("root_path")
    except Exception:
        pass

    # Prefer the explicit argument but log everything we saw
    logging.getLogger("chat_unified_stream").info(
        f"[unified_stream] arg_sid={session_id}, query_sid={q_sid}, cookie_sid={c_sid}, header_sid={hdr_sid}, root_path={root_path}"
    )

    session_id = require_session_id(session_id or q_sid or c_sid or hdr_sid)
    print("[UNIFIED STREAM] Client connected")
    
    async def clear_sent_request(sent_requests, request_key, delay):
        """Clear request_key from sent_requests after delay seconds"""
        await asyncio.sleep(delay)
        if request_key in sent_requests:
            sent_requests.discard(request_key)
    
    async def event_generator():
        sent_requests = set()  # Track sent requests to avoid duplicates
        heartbeat_counter = 0
        
        while True:
            try:
                # Check unified requests queue (no elif - checks every iteration)
                if not requests_queues[session_id].empty():
                    request = requests_queues[session_id].get_nowait()
                    request_type = request.get("type")
                    
                    # Build request key for duplicate detection
                    if request_type == "delete":
                        request_key = f"delete_{request.get('block_id')}"
                    else:
                        request_key = f"{request_type}_{request.get('request_id')}"
                    
                    # Avoid sending duplicate requests too quickly
                    if request_key not in sent_requests:
                        sent_requests.add(request_key)
                        yield f"data: {json.dumps(request)}\n\n"
                        
                        # Clear from sent_requests after 10 seconds
                        asyncio.create_task(clear_sent_request(sent_requests, request_key, 10))
                    else:
                        print(f"[SSE SKIP] Skipping duplicate request: {request_key}")
                
                else:
                    # Send a heartbeat every 30 seconds to keep connection alive
                    heartbeat_counter += 1
                    if heartbeat_counter >= 300:  # 300 * 0.1 = 30 seconds
                        yield f"data: {json.dumps({'heartbeat': True})}\n\n"
                        heartbeat_counter = 0
                    await asyncio.sleep(0.1)
                    
            except queue.Empty:
                await asyncio.sleep(0.1)
            except Exception as e:
                print(f"[SSE ERROR] {e}")
                await asyncio.sleep(1)
    
    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        }
    )

# Unified Server-Sent Events endpoint for all results from frontend
@app.get("/results_stream")
async def results_stream(session_id: str = None):
    session_id = require_session_id(session_id)
    print("[RESULTS STREAM] Client connected")
    
    async def event_generator():
        results_queue = results_queues[session_id]
        while True:
            try:
                # Check if there are any results to send
                if not results_queue.empty():
                    result_data = results_queue.get_nowait()
                    yield f"data: {json.dumps(result_data)}\n\n"
                else:
                    # Send a heartbeat every 30 seconds to keep connection alive
                    await asyncio.sleep(0.1)
            except queue.Empty:
                await asyncio.sleep(0.1)
            except Exception as e:
                print(f"[RESULTS SSE ERROR] {e}")
                await asyncio.sleep(1)
    
    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        }
    )

# Unified endpoint to receive all results from frontend
@app.post("/request_result")
async def request_result(request: Request):
    data = await request.json()
    request_type = data.get("request_type")
    session_id = require_session_id(data)
    
    # Log based on type
    if request_type == "delete":
        block_id = data.get("block_id")
        success = data.get("success")
        error = data.get("error")
        print(f"[RESULT RECEIVED] type={request_type}, block_id={block_id}, success={success}, error={redact_secrets(str(error))}")
    elif request_type == "variable":
        request_id = data.get("request_id")
        variable_id = data.get("variable_id")
        success = data.get("success")
        error = data.get("error")
        print(f"[RESULT RECEIVED] type={request_type}, request_id={request_id}, success={success}, error={redact_secrets(str(error))}, variable_id={variable_id}")
    elif request_type in ("create", "replace", "edit_mcp"):
        request_id = data.get("request_id")
        success = data.get("success")
        error = data.get("error")
        print(f"[RESULT RECEIVED] type={request_type}, request_id={request_id}, success={success}, error={redact_secrets(str(error))}")
    
    # Put directly in per-session results queue
    results_queues[session_id].put(data)
    
    return {"received": True}

def deploy_to_huggingface(space_name, hf_token=None, session_id=None):
    session_id = require_session_id(session_id)
    if not hf_token:
        return "[DEPLOY ERROR] No Hugging Face API key provided. Please set it in File > Keys."
    
    try:
        from huggingface_hub import HfApi
    except ImportError:
        return "[DEPLOY ERROR] huggingface_hub not installed. Run: pip install huggingface_hub"
    
    try:
        api = HfApi(token=hf_token)
        
        # Get username from token
        user_info = api.whoami()
        username = user_info["name"]
        repo_id = f"{username}/{space_name}"
        
        print(f"[DEPLOY] Creating HF Space: {repo_id}")
        
        # Create the Space
        api.create_repo(
            repo_id=repo_id,
            repo_type="space",
            space_sdk="gradio",
            private=False,
        )
        
        print(f"[DEPLOY] Space created. Uploading files...")
        
        # Get the actual generated Python code from test.py (not the Blockly DSL)
        python_code = ""
        try:
            resp = requests.get(
                f"http://127.0.0.1:{os.getenv('PORT', 8080)}/get_latest_code",
                params={"session_id": session_id},
                timeout=5,
            )
            if resp.ok:
                python_code = resp.json().get("code", "")
        except Exception as e:
            print(f"[DEPLOY WARN] Could not fetch Python code from test.py: {e}")
        
        if not python_code.strip():
            return "[DEPLOY ERROR] No generated Python code available. Create and test your tool first."
        
        # Upload app.py with actual Python code
        api.upload_file(
            path_or_fileobj=python_code.encode(),
            path_in_repo="app.py",
            repo_id=repo_id,
            repo_type="space",
        )
        
        # Create requirements.txt
        requirements_content = """gradio[mcp,oauth]==6.0.0
openai
requests
huggingface_hub
sympy
"""
        
        api.upload_file(
            path_or_fileobj=requirements_content.encode(),
            path_in_repo="requirements.txt",
            repo_id=repo_id,
            repo_type="space",
        )
        
        # Create README.md with proper YAML front matter
        readme_content = f"""---
title: {space_name.replace('-', ' ').title()}
emoji: 🚀
colorFrom: purple
colorTo: blue
sdk: gradio
app_file: app.py
pinned: false
---

# {space_name}

This is a MCP server created with [MCP Blockly](https://github.com/owenkaplinsky/mcp-blockly): a visual programming environment for building AI tools.

The tool has been automatically deployed to Hugging Face Spaces and is ready to use!
"""
        
        api.upload_file(
            path_or_fileobj=readme_content.encode("utf-8"),
            path_in_repo="README.md",
            repo_id=repo_id,
            repo_type="space",
        )
        
        space_url = f"https://huggingface.co/spaces/{repo_id}"
        print(f"[DEPLOY SUCCESS] Space deployed: {space_url}")
        
        # Store the MCP server URL per session for native MCP support
        session_deploy_state[session_id]["current_mcp_server_url"] = space_url
        session_deploy_state[session_id]["deployment_just_happened"] = True
        session_deploy_state[session_id]["deployment_message"] = (
            "Your MCP tool is being built on Hugging Face Spaces. This usually takes 1-2 minutes. Once it's ready, you'll be able to use the MCP tools defined in your blocks."
        )
        print(f"[MCP] Registered MCP server at {space_url}")
        
        return f"[TOOL] Successfully deployed to Hugging Face Space!\n\n**Space URL:** {space_url}"
        
    except Exception as e:
        print(f"[DEPLOY ERROR] {e}")
        import traceback
        traceback.print_exc()
        return f"[DEPLOY ERROR] Failed to deploy: {str(e)}"

def create_gradio_interface():
    # Define suggested prompts (emoji + short label -> longer full prompt)
    suggested_prompts = [
        {
            "label": "🤔 Explain features",
            "value": "Hi! I'm new here. Can you explain what things you can do for me?"
        },
        {
            "label": "💡 Brainstorm tools",
            "value": "I'm not sure what I should build... do you have any ideas?"
        },
        {
            "label": "🐛 Debug Issue",
            "value": "My code isn't working as expected. Why do you think that is?"
        }
    ]
    
    # Hardcoded system prompt

    SYSTEM_PROMPT = f"""You are an AI assistant that helps users build **Model Context Protocol (MCP) servers** using Blockly blocks.
    Your job is to be a helpful, educational assistant. One of your key strengths is your ability to help users understand MCP and
    create their first tool(s).

    You'll receive the workspace state in this format:
    `↿ blockId ↾ block_name(inputs(input_name: value))`

    Block ID parsing: Block IDs are everything between `↿` and `↾`. IDs are always complex/long strings.
    Example: `↿ ?fHZRh^|us|9bECO![$= ↾ text(inputs(TEXT: "hello"))`, ID is `?fHZRh^|us|9bECO![$=`
    
    Special cases:
    - `create_mcp` and `func_def` use `↿ blockId ↾ block_name(inputs(input_name: type), outputs(output_name: value))`
    - Indentation or nesting shows logic hierarchy (like loops or conditionals).

    ---

    ### Your job
    - Help users understand or fix their MCP logic in natural, human language.
    - You may reference the internal block syntax for your own understanding, but never show or explain it unless explicitly asked.
    - Focus on what the code *does* and what the user is trying to achieve, not on the raw block format.
    - When calling a tool, first state your plan and the steps, then perform the tool call in the same message.

    ---

    ### Using the MCP
    After deployment to a Hugging Face Space, all defined tools become available in the chat environment and can be invoked directly.

    **Deployment workflow:**
    1. Create and test the MCP using Blockly blocks  
    2. Deploy to a Hugging Face Space with `deploy_to_huggingface`  
    3. After deployment, the MCP tools are available immediately  
    4. The MCP server should only be run if the user requests it

    ---

    ### Deleting Blocks
    - Each block starts with its ID, like `↿ blockId ↾ block_name(...)`.
    - To delete a block, specify its block ID.
    - Any block except the main `create_mcp` block can be deleted.

    `↿ blockId ↾ code`

    Use the exact ID from the workspace.

    ---

    ### Creating Blocks
    List of blocks:

    {blocks_context}

    You cannot create a `create_mcp` block, but you may edit its inputs using the `edit_mcp` tool.

    ### Block Types: Statement vs Value
    **Statement blocks** (loops, conditionals, any container) hold other blocks inside them and require sequential creation to get the container's ID first.
    
    **Value blocks** (math, text, logic, comparison) produce values that plug into inputs and must be built entirely in one nested create_block call.

    ### How to Place Blocks
    
    **CRITICAL: Understand the difference between placing blocks INSIDE the MCP vs. placing blocks in MCP OUTPUTS**
    - The MCP block is a statement container (like a loop or conditional)
    - Blocks placed `type: "under"` with the MCP's blockID go INSIDE the MCP's code body
    - Blocks placed `type: "input"` with `input_name: "name"` only work if the MCP has explicit outputs defined
    - By default, the MCP does NOT have output slots - you must create/edit outputs first

    **IF/ELSE Blocks:**

    The entire IF/ELSE structure must be created in one `create_block` call.

    **Structure:**
    `controls_if(inputs(IF0: cond, IF1: cond2, IF2: cond3, ELSE))`

    - `IF0:` first/main condition (required)
    - `IF1:`, `IF2:`, `IF3:`, etc. - else-if conditions (optional)
    - `ELSE` keyword (optional, no value)

    **Do NOT:**
    - Add ELSE or ELSE-IF later using `input_name`
    - Give ELSE a value
    - Use `IF:` alone without a number (must be `IF0`)

    **Correct placement after creation:**
    - `input_name: "DO0"`: Main IF branch
    - `input_name: "DO1"`: First ELSE-IF branch
    - `input_name: "DO2"`: Second ELSE-IF branch
    - `input_name: "ELSE"`: ELSE branch

    YOU CANNOT EDIT THE IF BLOCK LATER. IF YOU WILL NEED TO HAVE AN ELSE OR IFELSE LATER, YOU MUST CREATE IT WITH ALL BRANCHES FROM THE START.

    **Placement types** - use `blockID` and `type` parameters:
    
    - `type: "under"` - For statement blocks inside containers. Create the container first, then create statement blocks using the container's ID.
      Example: Create a loop first, then use `blockID: loopID, type: "under"` to place code inside it.
      Optional: use `input_name` for statement input names only (e.g., "DO0", "DO1", "ELSE" for IF blocks).
      Example: `create_block(text_append(...), blockID: ifBlockID, type: "under", input_name: "DO0")` places the block in the IF branch.
    
    - `type: "input"` - ONLY for value blocks placed in MCP output slots.
      Example: `text(inputs(TEXT: "hello"))` with `type: "input", input_name: "name"` places the text block in the MCP's first output slot.
      Requirement: The create_mcp block must have explicit outputs defined (you will see `outputs(...)` in the workspace state). Do not use this if outputs are not visible.
    
    Key rule: Statement input names (DO0, DO1, ELSE) are for `type: "under"`. Output slot names are for `type: "input"`. Never mix them.
      
    **Value block nesting** - For value blocks inside other blocks: nest them directly in the create_block command (do not use `blockID` or `type`).
    Example: `math_arithmetic(inputs(A: math_number(inputs(NUM: 5)), B: math_number(inputs(NUM: 3))))`

    **CRITICAL for value block expressions**: You MUST build the entire nested structure in ONE create_block call. You cannot:
    - Create blocks in stages
    - Create intermediate blocks first and connect them later
    - Break a value expression into multiple separate create_block calls
    This is impossible. Value blocks can only be built by nesting them inside the create_block command.
    Example: `math_arithmetic(inputs(A: math_number(inputs(NUM: 1)), B: math_arithmetic(inputs(A: math_number(inputs(NUM: 2)), B: math_number(inputs(NUM: 3))))))`

    ### Input Rules
    Every block must have `inputs()`. For blocks that grow like `make_json` or `text_join`, add as many inputs as needed:
    - `text_join(inputs(ADD0: text(inputs(TEXT: "hello")), ADD1: text(inputs(TEXT: "world"))))`
    The blocks list will have comments saying something like "you can make as many N as you want" if this is allowed for that block.
    
    **String values must always be quoted with double quotes.** All configuration values (like operation names, parameter values, etc.) that are strings must be `"quoted"`:
    - WRONG: `math_single(inputs(OP: ROOT, NUM: value)`
    - CORRECT: `math_single(inputs(OP: "ROOT", NUM: value)`
    
    **Variable IDs must always be quoted with double quotes**, even if they look like identifiers. Variable IDs often contain special characters like parentheses, pipes, and semicolons. ALWAYS quote the variable ID:
    - WRONG: variables_set(inputs(VAR: ..., VALUE: ...))
    - CORRECT: variables_set(inputs(VAR: "...", VALUE: ...))

    For value inputs, never use raw values. Always wrap in a block:
    - WRONG: `math_arithmetic(inputs(A: 5, B: "hi"))`
    - RIGHT: `math_arithmetic(inputs(A: math_number(inputs(NUM: 5)), B: text(inputs(TEXT: "hi"))))`

    ---

    If you need to make a minor modification (e.g. change the amount of times a loop repeats, add an else if to an if) DO NOT delete the block and create a new one. ALWAYS use the replace tool instead.
    It preserves everything you don't want to change - NEVER delete it if you don't absolutely have to, try to replace instead.

    ---

    ### Variables
    Variables appear as:

    `↿ varId ↾ varName`

    ---

    ### Deploying to Hugging Face Spaces
    Steps:
    1. Ask the user for a Space name  
    2. Call `deploy_to_huggingface` with that name  
    3. A public Space is created and code is uploaded  

    Deployment is done only once; the deployed MCP may be run any number of times afterward.

    NEVER TRY DEPLOYING MORE THAN ONCE. YOU ONLY EVER NEED TO DEPLOY ONCE. AFTER THAT YOU CAN ONLY RUN IT.

    ---

    ## VALUE BLOCK CONSTRUCTION: ABSOLUTE RULE

    **Value blocks and value expressions must be built entirely in a SINGLE create_block call.**

    This is not negotiable. There is no alternative method. There is no workaround.

    When you need to create value blocks (math blocks, text blocks, logic blocks, comparison blocks, or any block that produces a value for another block to use), you must nest all of them together in one create_block call. All child blocks, all nested blocks, all sub-expressions must be included in that single call.

    **For any value expression, you have exactly ONE option: build it all in a single create_block call with all children nested inside.**

    You cannot call create_block multiple times for one value expression. You cannot create intermediate blocks and connect them later. These are not possible.

    **Correct:**
    `text_join(inputs(ADD0: text(inputs(TEXT: "a")), ADD1: text(inputs(TEXT: "b")), ADD2: text(inputs(TEXT: "c"))))`
    This is ONE call with all blocks nested in it.

    **Prohibited:**
    - `create_block(text(...))` then `create_block(text(...))` then `create_block(text(...))`: You cannot do this
    - Create one block, get its ID, then try to place other blocks in its inputs later: You cannot do this
    - Break a math expression across multiple calls: You cannot do this

    **Statement blocks are different.** Loops and conditionals require sequential calls because you need the container's ID first to place code inside it. But value blocks are not containers. They are atomic. Build the entire structure in one call or not at all.

    ---

    ## EVERY VALUE MUST HAVE A DESTINATION

    Before constructing ANY expression block (text_join, math operations, etc.), identify where it goes:
    - Assigned to a variable (via set_var block)
    - Passed as input to another block (nested in the create_block call)
    - Placed in an MCP output slot (using type: "input" and input_name: "name")
        - You CANNOT use type "under" to put a value block in the output slot of the MCP server. You MUST use "type" with "name".

    Do NOT create orphaned expression blocks with no destination. They serve no purpose.

    Always build the container/assignment block FIRST, then construct the value expression INSIDE it, both in a single call.

    Creating variables is not sufficient on its own. In addition to that, you MUST not forget to return the variable in the MCP block output slot.

    ### No Early Returns in Conditionals

    Blockly does not support early returns from within conditional branches. You MUST use a variable to store the result and return that variable in the MCP output:

    1. Create a variable
    2. In each branch, use a `set_var` block to assign the value to that variable. The VALUE input of set_var must contain your text_join or expression.
    3. Return the variable as an MCP output
    
    Always collect results in a variable first; never create expression blocks that exist outside a set_var or MCP output.

    ---

    Tool responses appear under the assistant role, but they are not part of your own words. Never treat tool output as
    something you said, and never fabricate or echo fake tool outputs.

    ---

    ## Important info

    Sometimes the user will ask questions about the environment you're in:
    - Creating a new project, opening a project, downloading the project code (the Python), and downloading the project (the blocks) are under the file dropdown
    - Right click on the workspace or go under edit dropdown to undo, redo, and clean up the workspace
    - Under the examples dropdown there is a weather API and fact checker MCP demo
    - Testing tab on the left side is for testing your MCP live with inputs and getting outputs
    - AI Chat tab (you) is toggleable (switch between testing and ai chat)

    If you don't know, just say so. But if these questions answer it, use these answers naturally.

     Additionally, never suggest project ideas that use APIs.

    ---

    ## REQUIRED PLANNING PHASE BEFORE ANY TOOL CALL

    Before creating or deleting any blocks, always begin with a *Planning Phase*:

    0. Acknowledge the `VALUE BLOCK CONSTRUCTION: ABSOLUTE RULE` section and how you are prohibited from doing multi step calls for value blocks, and must do it in one create block call.
    Then also acknowledge that you are required to set values in all MCP block output slots, and cannot forget and leave them empty.

    1. **Analyze the user's request.** Identify all required inputs, outputs, intermediate steps, loops, and conditionals.

    2. **Write pseudocode showing the complete flow** using readable syntax like function calls and control structures.
    This is for *your own* understanding: work out the logic *before* translating to blocks.
    Example: `for item in items: result = process(item); output = combine(result)`

    3. **Create a detailed, step-by-step to-do list**:  
    List every action you will take, in exact order, with no omissions. Build from the outside in: create outer containers first, then add inner blocks inside them.

    For every step, explicitly specify:  
    - What action you will perform  
    - Which block you are acting on  
    - Which input or output slot you are using  
    - All parameters involved (including type and input_name)  
    - Every variable used and where it is used

    For every IF statement you create, you must explicitly state:  
    - The number of IFELSE branches (0, 1, 2, etc.)  
    - The number of ELSE branches (0 or 1)  
    - The exact condition that causes each branch to activate

    THESE DECLARATIONS ARE REQUIRED EVERY TIME AN IF STATEMENT IS MENTIONED, AND YOU MUST ALWAYS PROVIDE EXACTLY THREE INTEGERS WITH NO EXCEPTIONS OR SUBSTITUTIONS. FAILURE TO DO SO IMMEDIATELY INVALIDATES THE RESPONSE IN ITS ENTIRETY.
    YOU MUST HAVE EXPLICITLY SAID THESE THREE VALUES NO MATTER WHAT. THIS IS NON-NEGOTIABLE. THIS IS A HARD REQUIREMENT. ALWAYS SAY THIS, EVERY SINGLE TIME, NO MATTER WHAT.

    4. **Check the create_mcp block state:** Before using `type: "input"` and `input_name: "name"`, verify that the create_mcp block has outputs defined in the workspace state. If you do not see `outputs(...)` in the create_mcp block, do NOT use these parameters.

    5. Perform the actions in order without asking for approval or asking to wait for intermediate results.
    
    6. Before stopping, you must confirm that every single output slot of the MCP block is filled. You must explicitly confirm this and if not all output slots are filled in, you must do so immediately.
    
    ---
    
    When coding, NEVER try to assume or guess ANY APIs. You must have the user provide you with exact API info and tell them exactly how to get it, if you need API stuff. Don't guess, ever. Additionally, never suggest project ideas that use APIs."""
    tools = [
        {
            "type": "function",
            "name": "delete_block",
            "description": "Delete a single block using its ID.",
            "parameters": {
                "type": "object",
                "properties": {
                    "id": {
                        "type": "string",
                        "description": "The ID of the block you're trying to delete.",
                    },
                },
                "required": ["id"],
            }
        },
        {
            "type": "function",
            "name": "create_block",
            "description": "Creates a single block that allows recursive nested blocks.",
            "parameters": {
                "type": "object",
                "properties": {
                    # Throwaway parameter to get the agent to think about what it wants to do again before it does it to increase reliability.
                    "notes": {
                        "type": "string",
                        "description": "Write the exact thing you need to make with this call. Cite your TODO list. If you're making an IF, say how many IF branches and whether it has an ELSE. Say the entire thing in plain text that your goal is.",
                    },
                    "command": {
                        "type": "string",
                        "description": "The create block command using the custom DSL format.",
                    },
                    "blockID": {
                        "type": "string",
                        "description": "The ID of the target block for placement. Do not use this if your goal is to place a block detached in the workspace.",
                    },
                    "type": {
                        "type": "string",
                        "enum": ["under", "input"],
                        "description": "Placement type. 'under' for statement blocks inside containers. 'input' only for value blocks in MCP outputs.",
                    },
                    "input_name": {
                        "type": "string",
                        "description": "ONLY for two cases: placing value blocks into MCP output slots using 'R<N>', and placing statement blocks into specific branches of controls_if (DO0, DO1, ELSE). NEVER USE THIS PARAMETER UNLESS YOU ARE DOING ONE OF THOSE TWO EXACT THINGS.",
                    },
                },
                "required": ["notes", "command"],
            }
        },
        {
            "type": "function",
            "name": "create_variable",
            "description": "Creates a variable.",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "The name of the variable you want to create.",
                    },
                },
                "required": ["name"],
            }
        },
        {
            "type": "function",
            "name": "edit_mcp",
            "description": "Edit the inputs and outputs of the create_mcp block.",
            "parameters": {
                "type": "object",
                "properties": {
                    "inputs": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "name": { "type": "string" },
                                "type": { "type": "string", "enum": ["string", "integer", "float", "list"] }
                            },
                            "required": ["name", "type"]
                        }
                    },
                    "outputs": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "name": { "type": "string" },
                                "type": { "type": "string", "enum": ["string", "integer", "float", "list"] }
                            },
                            "required": ["name", "type"]
                        }
                    }
                }
            }
        },
        {
            "type": "function",
            "name": "replace_block",
            "description": "Replace a block with a new block in the exact same location. The new block will take the place of the old one.",
            "parameters": {
                "type": "object",
                "properties": {
                    "block_id": {
                        "type": "string",
                        "description": "The ID of the block you want to replace.",
                    },
                    "command": {
                        "type": "string",
                        "description": "The create block command using the custom DSL format for the new block. You must rewrite it ENTIRELY from scratch.",
                    },
                },
                "required": ["block_id", "command"],
            }
        },
        {
            "type": "function",
            "name": "deploy_to_huggingface",
            "description": "Deploy the generated MCP tool to a Hugging Face Space. Requires a Hugging Face API key to be set.",
            "parameters": {
                "type": "object",
                "properties": {
                    "space_name": {
                        "type": "string",
                        "description": "The name of the Hugging Face Space to create (e.g., 'my-tool')",
                    },
                },
                "required": ["space_name"],
            }
        },
    ]
    
    def chat_with_context(message, history, request: gr.Request = None, session_id=None, openai_key=None, hf_token=None):
        """
        Chat handler. Keys are supplied per request (openai_key/hf_token) and are not stored.
        session_id is required for isolation; if omitted, a per-call UUID is used to avoid cross-talk.
        """
        global client
        # Resolve session_id from explicit arg, query, or cookie (no other fallback)
        if request:
            if not session_id:
                try:
                    session_id = request.query_params.get("session_id")
                except Exception:
                    session_id = None
            if not session_id:
                try:
                    session_id = request.cookies.get("mcp_blockly_session_id")
                except Exception:
                    session_id = None

        session_id = require_session_id(session_id)

        # Reset output block tracking for this conversation turn
        first_output_block_attempted = False

        # Resolve keys from request headers/cookies only (never stored)
        if request and not openai_key:
            openai_key = request.headers.get("x-openai-key") or request.cookies.get("mcp_openai_key")
        if request and not hf_token:
            hf_token = request.headers.get("x-hf-key") or request.cookies.get("mcp_hf_key")

        if not openai_key:
            yield "OpenAI API key not configured. Please set it in File > Keys in the Blockly interface."
            return

        # Create a throwaway client per call (no caching of secrets)
        try:
            client = OpenAI(api_key=openai_key)
        except Exception as e:
            yield f"Error initializing OpenAI client: {str(e)}"
            return

        # Get chat context (session-local)
        context = session_chat_state.get(session_id, {}).get("code", "")
        vars = session_chat_state.get(session_id, {}).get("vars", "")
        
        # Convert history (supports legacy tuples and newer ChatMessage/dict formats)
        input_items = []
        if history:
            for item in history:
                # Gradio 6 ChatMessage-like objects (duck-typed)
                if hasattr(item, "role") and hasattr(item, "content"):
                    # item.content is a list of parts; flatten text parts
                    texts = []
                    for part in item.content or []:
                        if isinstance(part, dict) and "text" in part:
                            texts.append(part["text"])
                        else:
                            texts.append(getattr(part, "text", str(part)))
                    content = "\n".join(t for t in texts if t)
                    if content:
                        input_items.append({"role": item.role, "content": content})
                    continue

                # Gradio serialized dict form
                if isinstance(item, dict) and "role" in item and "content" in item:
                    texts = []
                    for part in item.get("content") or []:
                        if isinstance(part, dict) and "text" in part:
                            texts.append(part["text"])
                        else:
                            texts.append(str(part))
                    content = "\n".join(t for t in texts if t)
                    if content:
                        input_items.append({"role": item["role"], "content": content})
                    continue

                    # Legacy tuple/list (user, assistant)
                if isinstance(item, (tuple, list)) and len(item) >= 2:
                    human, ai = item[0], item[1]
                    if human:
                        input_items.append({"role": "user", "content": human})
                    if ai:
                        input_items.append({"role": "assistant", "content": ai})
        
        # Build instructions
        instructions = SYSTEM_PROMPT
        if context:
            instructions += f"\n\nCurrent Blockly workspace state:\n{context}"
        else:
            instructions += "\n\nNote: No Blockly workspace context is currently available."
        
        if vars != "":
            instructions += f"\n\nCurrent Blockly variables:\n{vars}"
        else:
            instructions += "\n\nNote: No Blockly variables are currently available."
        
        # Iteration control
        accumulated_response = ""
        max_iterations = 15
        current_iteration = 0
        
        # Start with original user message
        current_prompt = message
        temp_input_items = input_items.copy()
        
        # MAIN LOOP
        while current_iteration < max_iterations:
            current_iteration += 1
            
            try:
                # Build dynamic tools list with MCP support
                dynamic_tools = tools.copy() if tools else []
                
                # Inject MCP tool if a server is registered
                space_building_status = None  # Track if space is building
                deploy_state = session_deploy_state[session_id]
                current_mcp_server_url = deploy_state.get("current_mcp_server_url")
                if current_mcp_server_url:
                    mcp_injection_successful = False
                    try:
                        # Try to verify the MCP server is available before injecting
                        space_is_running = False
                        try:
                            # Extract username and space name from URL
                            # URL format: https://huggingface.co/spaces/username/space_name
                            url_parts = current_mcp_server_url.split("/spaces/")
                            if len(url_parts) == 2:
                                space_id = url_parts[1]
                                api = HfApi()
                                runtime_info = api.get_space_runtime(space_id)
                                print(f"[MCP] Space runtime status: {runtime_info}")
                                # Check if space is running
                                if runtime_info and runtime_info.stage == "RUNNING":
                                    space_is_running = True
                                    # Space is running - deployment is complete
                                    deploy_state["deployment_just_happened"] = False
                                    print(f"[MCP] Space is RUNNING")
                                else:
                                    # Space is not running - it's likely building
                                    space_building_status = runtime_info.stage if runtime_info else "unknown"
                                    print(f"[MCP] Space is not running yet (stage: {space_building_status})")
                        except Exception as check_error:
                            print(f"[MCP] Could not verify space runtime: {check_error}")
                        
                        # Only inject the MCP tool if the space is verified running
                        if space_is_running:
                            def convert_repo_to_live_mcp(url):
                                # input:  https://huggingface.co/spaces/user/space
                                # output: https://user-space.hf.space/gradio_api/mcp

                                parts = url.split("/spaces/")
                                user, space = parts[1].split("/")
                                return f"https://{user}-{space}.hf.space/gradio_api/mcp/"

                            live_mcp_url = convert_repo_to_live_mcp(current_mcp_server_url)

                            mcp_tool = {
                                "type": "mcp",
                                "server_url": live_mcp_url,
                                "server_label": "user_mcp_server",
                                "require_approval": "never"
                            }
                            dynamic_tools.append(mcp_tool)
                    except Exception as mcp_error:
                        print(f"[MCP ERROR] Failed during MCP injection: {mcp_error}")
                
                # Add deployment status message to instructions if deployment just happened and space is not running
                deployment_instructions = instructions
                if deploy_state.get("deployment_just_happened") and space_building_status and space_building_status != "RUNNING":
                    deployment_instructions = instructions + f"\n\n**MCP DEPLOYMENT STATUS:** {deploy_state.get('deployment_message')}"
                
                # Create Responses API call
                response = client.responses.create(
                    model="gpt-4o",
                    instructions=deployment_instructions,
                    input=temp_input_items + [{"role": "user", "content": current_prompt}],
                    tools=dynamic_tools,
                    tool_choice="auto",
                    parallel_tool_calls=False
                )
                
                # print(response)
                
                # Extract outputs
                ai_response = ""
                tool_calls = []
                
                for item in response.output:
                    
                    if item.type == "message":
                        # Extract assistant text
                        for content in item.content:
                            if content.type == "output_text":
                                ai_response = content.text
                    
                    elif item.type == "function_call":
                        # Collect tool calls
                        tool_calls.append(item)
                
                # PROCESSING TOOL CALLS
                if tool_calls:
                    # Show assistant text FIRST if it exists
                    if ai_response:
                        if accumulated_response:
                            accumulated_response += "\n\n"
                        accumulated_response += ai_response
                        yield accumulated_response

                    # Now process each tool call, one by one
                    for tool_call in tool_calls:
                        function_name = tool_call.name
                        function_args = json.loads(tool_call.arguments)
                        call_id = tool_call.call_id
                        
                        temp_input_items.append({"role": "user", "content": current_prompt})
                        temp_input_items.append({"role": "assistant", "content": ai_response})

                        temp_input_items.append({
                            "type": "function_call",
                            "call_id": call_id,
                            "name": function_name,
                            "arguments": tool_call.arguments
                        })
                        
                        # Execute the tool
                        tool_result = None
                        result_label = ""
                        
                        if function_name == "delete_block":
                            block_id = function_args.get("id", "")
                            print(Fore.YELLOW + f"Agent deleted block with ID `{block_id}`." + Style.RESET_ALL)
                            tool_result = delete_block(block_id, session_id=session_id)
                            result_label = "Delete Operation"
                        
                        elif function_name == "create_block":
                            command = function_args.get("command", "")
                            blockID = function_args.get("blockID", None)
                            placement_type = function_args.get("type", None)
                            input_name = function_args.get("input_name", None)
                            
                            # Validate that parentheses are balanced, ignoring ones in strings
                            # Allow leniency: auto-add up to 1 missing closing parenthesis
                            command_stripped = command.strip()
                            open_parens = 0
                            close_parens = 0
                            in_string = False
                            string_char = ''
                            i = 0
                            while i < len(command_stripped):
                                char = command_stripped[i]
                                # Handle string escaping
                                if char in ('"', "'") and (i == 0 or command_stripped[i-1] != '\\'):
                                    if not in_string:
                                        in_string = True
                                        string_char = char
                                    elif char == string_char:
                                        in_string = False
                                # Count parentheses only outside of strings
                                elif not in_string:
                                    if char == '(':
                                        open_parens += 1
                                    elif char == ')':
                                        close_parens += 1
                                i += 1
                            
                            paren_diff = open_parens - close_parens
                            if paren_diff == 1:
                                # Auto-fix: add one closing parenthesis
                                command = command_stripped + ')'
                                print(Fore.YELLOW + f"[LENIENCY] Auto-fixed 1 missing closing parenthesis." + Style.RESET_ALL)
                                # Continue with block creation below
                                tool_result = None
                                result_label = ""
                            elif paren_diff > 1:
                                tool_result = f"[ERROR] Malformatted command: Too many unbalanced parentheses ({paren_diff} missing). The attempted command was:\n\n`{command_stripped}`\n\nPlease retry with properly balanced parentheses."
                                result_label = "Command Format Error"
                                print(Fore.RED + f"[VALIDATION ERROR] Unbalanced parentheses: {open_parens} open, {close_parens} close." + Style.RESET_ALL)
                            elif paren_diff < 0:
                                tool_result = f"[ERROR] Malformatted command: Too many closing parentheses ({-paren_diff} extra). The attempted command was:\n\n`{command_stripped}`\n\nPlease retry with properly balanced parentheses."
                                result_label = "Command Format Error"
                                print(Fore.RED + f"[VALIDATION ERROR] Unbalanced parentheses: {open_parens} open, {close_parens} close." + Style.RESET_ALL)
                            
                            # Only proceed if validation passed (no error was set)
                            if tool_result is None:
                                # Validate type: "input" usage with input_name
                                if placement_type == "input" and input_name:
                                    valid_mcp_outputs = all(input_name.startswith("R") and input_name[1:].isdigit() for _ in [input_name]) if input_name.startswith("R") else False
                                    valid_conditional_branches = input_name in ("DO0", "DO1", "DO2", "DO3", "DO4", "DO5", "ELSE") or input_name.startswith("DO")
                                    
                                    if not valid_mcp_outputs and not valid_conditional_branches:
                                        tool_result = f"[ERROR] Invalid input_name '{input_name}' used with type: 'input'. Valid values are:\n- MCP output slots: 'R0', 'R1', 'R2', etc.\n- Conditional branches: 'DO0', 'DO1', 'DO2', etc., or 'ELSE'\n\nThe attempted command was:\n\n`{command_stripped}`"
                                        result_label = "Invalid Placement Error"
                                        print(Fore.RED + f"[VALIDATION ERROR] Invalid input_name for type 'input': {input_name}" + Style.RESET_ALL)
                                
                                # Only proceed if no validation errors
                                if tool_result is None:
                                    # Check if this is the first MCP output block creation attempt
                                    if (not first_output_block_attempted and 
                                        placement_type == "input" and 
                                        input_name and 
                                        input_name.startswith("R")):
                                        # Mark that we've attempted an output block in this conversation
                                        first_output_block_attempted = True
                                        # Return warning instead of creating the block
                                        tool_result = "[TOOL] Automated warning: Make sure your output block contains the full and entire value needed. Block placement was **not** executed. Retry with the full command needed in one go."
                                        result_label = "Output Block Warning"
                                        print(Fore.YELLOW + f"[FIRST OUTPUT BLOCK] Intercepted first output block attempt with command `{command}`." + Style.RESET_ALL)
                                    else:
                                        # Normal block creation
                                        if blockID is None:
                                            print(Fore.YELLOW + f"Agent created block with command `{command}`." + Style.RESET_ALL)
                                        else:
                                            print(Fore.YELLOW + f"Agent created block with command `{command}`, type: {placement_type}, blockID: `{blockID}`." + Style.RESET_ALL)
                                        if input_name:
                                            print(Fore.YELLOW + f"  Input name: {input_name}" + Style.RESET_ALL)
                                        tool_result = create_block(command, blockID, placement_type, input_name, session_id=session_id)
                                        result_label = "Create Operation"
                        
                        elif function_name == "create_variable":
                            name = function_args.get("name", "")
                            print(Fore.YELLOW + f"Agent created variable with name `{name}`." + Style.RESET_ALL)
                            tool_result = create_variable(name, session_id=session_id)
                            result_label = "Create Var Operation"
                        
                        elif function_name == "edit_mcp":
                            inputs = function_args.get("inputs", None)
                            outputs = function_args.get("outputs", None)
                            print(Fore.YELLOW + f"Agent editing MCP block: inputs={inputs}, outputs={outputs}." + Style.RESET_ALL)
                            tool_result = edit_mcp(inputs, outputs, session_id=session_id)
                            result_label = "Edit MCP Operation"
                        
                        elif function_name == "replace_block":
                            block_id = function_args.get("block_id", "")
                            command = function_args.get("command", "")
                            print(Fore.YELLOW + f"Agent replacing block with ID `{block_id}` with command `{command}`." + Style.RESET_ALL)
                            tool_result = replace_block(block_id, command, session_id=session_id)
                            result_label = "Replace Block Operation"
                        
                        elif function_name == "deploy_to_huggingface":
                            space_name = function_args.get("space_name", "")
                            print(Fore.YELLOW + f"Agent deploying to Hugging Face Space `{space_name}`." + Style.RESET_ALL)
                            tool_result = deploy_to_huggingface(space_name, hf_token=hf_token, session_id=session_id)
                            result_label = "Deployment Result"
                        
                        # SHOW TOOL RESULT IMMEDIATELY
                        if tool_result is not None:
                            print(Fore.YELLOW + f"[TOOL RESULT] {tool_result}" + Style.RESET_ALL)
                            
                            if accumulated_response:
                                accumulated_response += "\n\n"
                            accumulated_response += f"**{result_label}:** {tool_result}"
                            yield accumulated_response
                        
                        # Append the tool result into the conversation for the model
                        temp_input_items.append({
                            "type": "function_call_output",
                            "call_id": tool_call.call_id,
                            "output": str(tool_result)
                        })
                    
                    # Tell model to respond to tool result
                    current_prompt = "The tool has been executed with the result shown above. Please respond appropriately."
                    
                    continue
                
                else:
                    if ai_response:
                        if accumulated_response:
                            accumulated_response += "\n\n"
                        accumulated_response += ai_response
                    
                    yield accumulated_response
                    break

            except Exception as e:
                if accumulated_response:
                    yield f"{accumulated_response}\n\nError in iteration {current_iteration}: {str(e)}"
                else:
                    yield f"Error: {str(e)}"
                return
        
        # Max iterations reached
        if current_iteration >= max_iterations:
            accumulated_response += f"\n\n*(Reached maximum of {max_iterations} consecutive responses)*"
            yield accumulated_response


    # Attach to Gradio ChatInterface with suggested prompts
    demo = gr.ChatInterface(
        fn=chat_with_context,
        examples=[prompt["value"] for prompt in suggested_prompts],
        example_labels=[prompt["label"] for prompt in suggested_prompts],
    )

    return demo


def get_chat_gradio_interface():
    return create_gradio_interface()


if __name__ == "__main__":
    demo = create_gradio_interface()
    app = gr.mount_gradio_app(app, demo, path="/", show_error=False)
