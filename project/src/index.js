import * as Blockly from 'blockly';
import { blocks } from './blocks/text';
import { forBlock } from './generators/python';
import { pythonGenerator } from 'blockly/python';
import { chatGenerator, forBlock as chatForBlock } from './generators/chat';
import { save, load } from './serialization';
import { toolbox } from './toolbox';
import '@blockly/toolbox-search';
import DarkTheme from '@blockly/theme-dark';
import './index.css';

// Determine the correct base path when running behind HF proxy (/proxy/... or /spaces/...)
const getBasePath = () => {
  const p = window.location.pathname || "";
  if (p.startsWith("/proxy/")) {
    const parts = p.split("/").filter(Boolean); // proxy/owner/space[/...]
    return "/" + parts.slice(0, 3).join("/");
  }
  if (p.startsWith("/spaces/")) {
    const parts = p.split("/").filter(Boolean); // spaces/owner/space[/...]
    return "/" + parts.slice(0, 3).join("/");
  }
  return "";
};

const basePath = getBasePath();

// Session ID Handling
function getOrCreateSessionId() {
  const STORAGE_KEY = "mcp_blockly_session_id";

  let sessionId = window.localStorage.getItem(STORAGE_KEY);
  if (!sessionId) {
    if (window.crypto && window.crypto.randomUUID) {
      sessionId = window.crypto.randomUUID();
    } else {
      sessionId = "sess_" + Math.random().toString(36).substring(2) + Date.now().toString(36);
    }
    window.localStorage.setItem(STORAGE_KEY, sessionId);
  }

  return sessionId;
}

const sessionId = getOrCreateSessionId();
window.sessionId = sessionId;
console.log("[SESSION] Using sessionId:", sessionId);
// Share session id with other mounted apps (e.g., Gradio tester) via cookie
const sameSite = window.location.protocol === "https:" ? "None" : "Lax";
const secure = window.location.protocol === "https:" ? "; Secure" : "";
const maxAge = 60 * 60 * 24 * 7; // one week
document.cookie = `mcp_blockly_session_id=${sessionId}; path=/; Max-Age=${maxAge}; SameSite=${sameSite}${secure}`;

// Ensure embedded Gradio iframes receive the session id even when third-party cookies are blocked
function attachSessionToIframes() {
  const frames = [
    document.getElementById("gradioTestFrame"),
    document.getElementById("gradioChatFrame"),
  ];

  frames.forEach((frame) => {
    if (!frame) return;
    const baseSrc = frame.dataset.baseSrc || frame.getAttribute("src") || "";
    if (!baseSrc) return;
    // Prefix proxy base when iframe src is absolute-from-root
    const resolvedBaseSrc = baseSrc.startsWith("/") ? `${basePath}${baseSrc}` : baseSrc;
    const joiner = baseSrc.includes("?") ? "&" : "?";
    frame.src = `${resolvedBaseSrc}${joiner}session_id=${encodeURIComponent(sessionId)}&__theme=dark`;
  });
}

attachSessionToIframes();

// Register the blocks and generator with Blockly
Blockly.common.defineBlocks(blocks);
Object.assign(pythonGenerator.forBlock, forBlock);

// Register chat generator blocks
Object.assign(chatGenerator.forBlock, chatForBlock);

// Set up UI elements and inject Blockly
const blocklyDiv = document.getElementById('blocklyDiv');

// Inject Blockly with theme + renderer
const ws = Blockly.inject(blocklyDiv, {
  toolbox,
  grid: {
    spacing: 35,
    length: 3,
    colour: '#ccc',
    snap: false
  },
  disable: false,
  collapse: false,
  zoom: {
    controls: true,
    wheel: true,
    startScale: 1.0,
    maxScale: 3,
    minScale: 0.3,
    scaleSpeed: 1.2,
    pinch: true
  },
  renderer: 'zelos',
  theme: DarkTheme,
});

window.workspace = ws;

Blockly.ContextMenuItems.registerCommentOptions();

const newButton = document.querySelector('#newButton');

newButton.addEventListener("click", () => {
  ws.clear()

  // Create the MCP block
  const mcpBlock = ws.newBlock('create_mcp');
  mcpBlock.initSvg();
  mcpBlock.setDeletable(false);
  mcpBlock.setMovable(true);  // Allow moving but not deleting

  // Position it in a reasonable spot
  mcpBlock.moveBy(50, 50);
  mcpBlock.render();
});

loadButton.addEventListener("click", () => {
  const input = document.createElement('input');
  let fileContent;
  input.type = 'file';
  input.accept = '.txt'; // Specify the file types you want to accept
  input.onchange = function (event) {
    const file = event.target.files[0];
    const reader = new FileReader();
    reader.onload = function (event) {
      fileContent = JSON.parse(event.target.result); // Parse directly without decoding
      Blockly.serialization.workspaces.load(fileContent, ws);
    };
    reader.readAsText(file);
  };
  input.click();
});

saveButton.addEventListener("click", () => {
  const state = Blockly.serialization.workspaces.save(ws);
  const stateString = JSON.stringify(state);

  var filename = "mcpBlockly_project.txt";
  var element = document.createElement('a');

  element.setAttribute('href', 'data:text/plain;charset=utf-8,' + encodeURIComponent(stateString));
  element.setAttribute('download', filename);
  element.style.display = 'none';
  document.body.appendChild(element);
  element.click();
  document.body.removeChild(element);
});

// Download Code button
const downloadCodeButton = document.querySelector('#downloadCodeButton');
downloadCodeButton.addEventListener("click", () => {
  // Get the current generated code
  const codeEl = document.querySelector('#generatedCode code');
  const code = codeEl ? codeEl.textContent : '';

  if (!code) {
    alert('No code to download');
    return;
  }

  var filename = "app.py";
  var element = document.createElement('a');

  element.setAttribute('href', 'data:text/plain;charset=utf-8,' + encodeURIComponent(code));
  element.setAttribute('download', filename);
  element.style.display = 'none';
  document.body.appendChild(element);
  element.click();
  document.body.removeChild(element);
});

// Settings button and Keys Modal
const settingsButton = document.querySelector('#settingsButton');
const apiKeyModal = document.querySelector('#apiKeyModal');
const apiKeyInput = document.querySelector('#apiKeyInput');
const hfKeyInput = document.querySelector('#hfKeyInput');
const saveApiKeyButton = document.querySelector('#saveApiKey');
const cancelApiKeyButton = document.querySelector('#cancelApiKey');

const OPENAI_KEY_STORAGE = "mcp_blockly_openai_key";
const HF_KEY_STORAGE = "mcp_blockly_hf_key";

const loadStoredKeys = () => {
  const storedOpenAI = window.localStorage.getItem(OPENAI_KEY_STORAGE) || "";
  const storedHF = window.localStorage.getItem(HF_KEY_STORAGE) || "";
  if (apiKeyInput) {
    apiKeyInput.value = storedOpenAI;
  }
  if (hfKeyInput) {
    hfKeyInput.value = storedHF;
  }
};

settingsButton.addEventListener("click", () => {
  if (hfKeyInput) {
    loadStoredKeys();
  } else {
    console.warn("[Settings] HF key input not found in DOM");
  }
  apiKeyModal.style.display = 'flex';
});

saveApiKeyButton.addEventListener("click", () => {
  const apiKey = apiKeyInput?.value.trim() || "";
  const hfKey = hfKeyInput?.value.trim() || "";

  // Validate OpenAI key format (required)
  if (!apiKey || !apiKey.startsWith("sk-") || apiKey.length < 40) {
    alert("OpenAI API key is required. Please enter a valid OpenAI API key (starts with 'sk-').");
    return;
  }

  // Validate Hugging Face key format if provided
  if (hfKey && (!hfKey.startsWith("hf_") || hfKey.length < 20)) {
    alert("Invalid Hugging Face API key format. Please enter a valid Hugging Face API key (starts with 'hf_').");
    return;
  }

  // Save API keys locally
  window.localStorage.setItem(OPENAI_KEY_STORAGE, apiKey);
  window.localStorage.setItem(HF_KEY_STORAGE, hfKey);

  // Share keys with backend via cookies (per-request, not stored server-side)
  const cookieOpts = "path=/; SameSite=None; Secure";
  if (apiKey) {
    document.cookie = `mcp_openai_key=${encodeURIComponent(apiKey)}; ${cookieOpts}`;
  } else {
    document.cookie = `mcp_openai_key=; Max-Age=0; ${cookieOpts}`;
  }
  if (hfKey) {
    document.cookie = `mcp_hf_key=${encodeURIComponent(hfKey)}; ${cookieOpts}`;
  } else {
    document.cookie = `mcp_hf_key=; Max-Age=0; ${cookieOpts}`;
  }

  alert('API keys saved successfully');
  apiKeyModal.style.display = 'none';
});

cancelApiKeyButton.addEventListener("click", () => {
  apiKeyModal.style.display = 'none';
});

// Welcome Modal Setup
const welcomeModal = document.querySelector('#welcomeModal');
const welcomeApiKeyInput = document.querySelector('#welcomeApiKeyInput');
const welcomeHfKeyInput = document.querySelector('#welcomeHfKeyInput');
const saveWelcomeApiKeyButton = document.querySelector('#saveWelcomeApiKey');
const skipTutorialButton = document.querySelector('#skipTutorialButton');
const dontShowWelcomeAgainCheckbox = document.querySelector('#dontShowWelcomeAgain');

const WELCOME_DISMISSED_COOKIE = "mcp_blockly_welcome_dismissed";

const getCookieValue = (name) => {
  const value = `; ${document.cookie}`;
  const parts = value.split(`; ${name}=`);
  if (parts.length === 2) return parts.pop().split(';').shift();
  return null;
};

const loadWelcomeStoredKeys = () => {
  const storedOpenAI = window.localStorage.getItem(OPENAI_KEY_STORAGE) || "";
  const storedHF = window.localStorage.getItem(HF_KEY_STORAGE) || "";
  welcomeApiKeyInput.value = storedOpenAI;
  welcomeHfKeyInput.value = storedHF;
};

const showWelcomeModal = () => {
  loadWelcomeStoredKeys();
  dontShowWelcomeAgainCheckbox.checked = false;
  welcomeModal.style.display = 'flex';
};

const hideWelcomeModal = () => {
  welcomeModal.style.display = 'none';
  if (dontShowWelcomeAgainCheckbox.checked) {
    const maxAge = 60 * 60 * 24 * 365; // one year
    const sameSite = window.location.protocol === "https:" ? "None" : "Lax";
    const secure = window.location.protocol === "https:" ? "; Secure" : "";
    document.cookie = `${WELCOME_DISMISSED_COOKIE}=true; path=/; Max-Age=${maxAge}; SameSite=${sameSite}${secure}`;
  }
};

// Helper function to save welcome modal keys
const saveWelcomeKeys = (requireValidation = true) => {
  const apiKey = welcomeApiKeyInput.value.trim();
  const hfKey = welcomeHfKeyInput.value.trim();

  // Validate OpenAI key format (required if requireValidation is true)
  if (requireValidation && (!apiKey || !apiKey.startsWith("sk-") || apiKey.length < 40)) {
    alert("OpenAI API key is required. Please enter a valid OpenAI API key (starts with 'sk-').");
    return false;
  }

  // Validate Hugging Face key format if provided
  if (hfKey && (!hfKey.startsWith("hf_") || hfKey.length < 20)) {
    alert("Invalid Hugging Face API key format. Please enter a valid Hugging Face API key (starts with 'hf_').");
    return false;
  }

  // Save API keys locally if apiKey is provided
  if (apiKey) {
    console.log("[Welcome] Saving keys to localStorage");
    window.localStorage.setItem(OPENAI_KEY_STORAGE, apiKey);
    window.localStorage.setItem(HF_KEY_STORAGE, hfKey);

    // Share keys with backend via cookies (per-request, not stored server-side)
    const cookieOpts = "path=/; SameSite=None; Secure";
    document.cookie = `mcp_openai_key=${encodeURIComponent(apiKey)}; ${cookieOpts}`;
    if (hfKey) {
      document.cookie = `mcp_hf_key=${encodeURIComponent(hfKey)}; ${cookieOpts}`;
    }
  }
  
  return true;
};

saveWelcomeApiKeyButton.addEventListener("click", () => {
  if (!saveWelcomeKeys(true)) {
    return;
  }

  hideWelcomeModal();
  
  // Trigger the tutorial flow
  tutorialEnabled = true;
  completedTutorialStepIndex = -1;
  examplesJustFlashed = false;
  checkAndFlashExamplesButton();
});

skipTutorialButton.addEventListener("click", () => {
  // Save keys even if skipping tutorial (no validation required)
  saveWelcomeKeys(false);
  
  tutorialEnabled = false;
  hideWelcomeModal();
});

// Show welcome modal on first visit
const welcomeDismissed = getCookieValue(WELCOME_DISMISSED_COOKIE);
console.log('[Welcome] Cookie value:', welcomeDismissed);
if (!welcomeDismissed) {
  // Delay showing welcome to ensure page is fully loaded
  setTimeout(() => {
    console.log('[Welcome] Showing welcome modal');
    showWelcomeModal();
  }, 100);
} else {
  console.log('[Welcome] Welcome modal dismissed, skipping');
}

const weatherText = '{"workspaceComments":[{"height":80,"width":477,"id":"XI5[EHp-Ow+kinXf6n5y","x":51.0743994140625,"y":-53.56000305175782,"text":"Gets temperature of location with a latitude and a longitude."}],"blocks":{"languageVersion":0,"blocks":[{"type":"create_mcp","id":")N.HEG1x]Z/,k#TeWr,S","x":50,"y":50,"deletable":false,"extraState":{"inputCount":2,"inputNames":["latitude","longitude"],"inputTypes":["float","float"],"outputCount":1,"outputNames":["output0"],"outputTypes":["float"],"toolCount":0},"inputs":{"X0":{"block":{"type":"input_reference_latitude","id":"]3mj!y}qfRt+!okheU7L","deletable":false,"extraState":{"ownerBlockId":")N.HEG1x]Z/,k#TeWr,S"},"fields":{"VARNAME":"latitude"}}},"X1":{"block":{"type":"input_reference_longitude","id":"Do/{HFNGSd.!;POiKS?D","deletable":false,"extraState":{"ownerBlockId":")N.HEG1x]Z/,k#TeWr,S"},"fields":{"VARNAME":"longitude"}}},"R0":{"block":{"type":"cast_as","id":"vKz#fsrWMW(M9*:3Pv;2","fields":{"TYPE":"float"},"inputs":{"VALUE":{"block":{"type":"in_json","id":"R|j?_8s^H{l0;UZ-oQt3","inputs":{"NAME":{"block":{"type":"text","id":"@Z+@U^@8c0gQYj}La`PY","fields":{"TEXT":"temperature_2m"}}},"JSON":{"block":{"type":"in_json","id":"X=M,R1@7bRjJVZIPi[qD","inputs":{"NAME":{"block":{"type":"text","id":"OMr~`#kG$3@k`YPDHbzH","fields":{"TEXT":"current"}}},"JSON":{"block":{"type":"call_api","id":"^(.vyM.yni08S~c1EBm=","fields":{"METHOD":"GET"},"inputs":{"URL":{"shadow":{"type":"text","id":"}.T;_U_OsRS)B_y09p % { ","fields":{"TEXT":""}},"block":{"type":"text_replace","id":"OwH9uERJPTGQG!UER#ch","inputs":{"FROM":{"shadow":{"type":"text","id":"ya05#^ 7 % UbUeXX#eDSmH","fields":{"TEXT":"{latitude}"}},"block":{"type":"text","id":"6CX#+wo9^x+vZ`LRt5ms","fields":{"TEXT":"{latitude}"}}},"TO":{"shadow":{"type":"text","id":": _ZloQuh9c-MNf-U]!k5","fields":{"TEXT":""}},"block":{"type":"cast_as","id":"qXXp2GSF;@+ssDvHN={+","fields":{"TYPE":"str"},"inputs":{"VALUE":{"block":{"type":"input_reference_latitude","id":"?%@)3sErZ)}=#4ags#gu","extraState":{"ownerBlockId":")N.HEG1x]Z/,k#TeWr,S"},"fields":{"VARNAME":"latitude"}}}}}},"TEXT":{"shadow":{"type":"text","id":"w@zsP)m6:WjkUp,ln3$x","fields":{"TEXT":""}},"block":{"type":"text_replace","id":"ImNPsvzD7r^+1MJ%IirV","inputs":{"FROM":{"shadow":{"type":"text","id":"%o(3rro?WLIFpmE0#MMM","fields":{"TEXT":"{longitude}"}},"block":{"type":"text","id":"`p!s8dQ7e~?0JvofyB-{","fields":{"TEXT":"{longitude}"}}},"TO":{"shadow":{"type":"text","id":"Zpql-%oJ_sdSi | r |* er | ","fields":{"TEXT":""}},"block":{"type":"cast_as","id":"T5r7Y,;]kq2wClH)JUf8","fields":{"TYPE":"str"},"inputs":{"VALUE":{"block":{"type":"input_reference_longitude","id":"WUgiJP$X + zY#f$5nhnTX","extraState":{"ownerBlockId":") N.HEG1x]Z /, k#TeWr, S"},"fields":{"VARNAME":"longitude"}}}}}},"TEXT":{"shadow":{"type":"text","id":", (vw$o_s7P = b4P; 8]}yj","fields":{"TEXT":"https://api.open-meteo.com/v1/forecast?latitude={latitude}&longitude={longitude}&current=temperature_2m,wind_speed_10m"}}}}}}}}}}}}}}}}}}}}}}}]}}';
let examplesJustFlashed = false;
let selectedExample = null; // Track which example was selected
let tutorialEnabled = false; // Track if tutorial is enabled

// Tutorial popup management
const tutorialStepOrder = ['examples', 'refresh', 'test', 'aiAssistant', 'send'];
let completedTutorialStepIndex = -1;
const getTutorialStepIndex = (step) => tutorialStepOrder.indexOf(step);
const hasCompletedStepOrBeyond = (step) => {
  const idx = getTutorialStepIndex(step);
  return idx !== -1 && completedTutorialStepIndex >= idx;
};
const markTutorialStepComplete = (step) => {
  const idx = getTutorialStepIndex(step);
  if (idx > completedTutorialStepIndex) {
    completedTutorialStepIndex = idx;
  }
};
let currentTutorialStep = null;
const tutorialPopup = document.getElementById('tutorialPopup');
const tutorialTitle = document.getElementById('tutorialTitle');
const tutorialBody = document.getElementById('tutorialBody');
const tutorialSkipButton = document.getElementById('tutorialSkipButton');
console.log('[TUTORIAL] Popup elements:', { tutorialPopup, tutorialTitle, tutorialBody, tutorialSkipButton });

const tutorialContent = {
  examples: {
    title: '1/5 Try an Example',
    body: 'Click on one of the example workflows to get started quickly.'
  },
  refresh: {
    title: '2/5 Refresh Info',
    body: 'Click the Refresh button to update the inputs and outputs of your MCP server.'
  },
  test: {
    title: '3/5 Run Your Test',
    get body() {
      if (selectedExample === 'weather') {
        return 'Enter a latitude (-90 to 90) and longitude (-180 to 80), then press Test to get the current temperature at that location!';
      } else if (selectedExample === 'fact') {
        return 'Enter a claim you want to verify, then press Test to check if it\'s true!';
      }
      return 'Enter some values in your MCP inputs, and press the Test button to see its output.';
    }
  },
  aiAssistant: {
    title: '4/5 Get AI Guidance',
    body: 'After your output is generated, switch to the AI Assistant tab to chat with the integrated agent.'
  },
  send: {
    title: '5/5 Send a Message',
    body: 'Try using one of the three suggested prompts (click on one of the buttons), or write one of your own!'
  }
};

const showTutorialPopup = (step, targetElement) => {
  console.log('[TUTORIAL] showTutorialPopup called for step:', step, 'element:', targetElement);
  if (!tutorialContent[step]) {
    console.log('[TUTORIAL] Content not found for step:', step);
    return;
  }
  
  currentTutorialStep = step;
  tutorialTitle.textContent = tutorialContent[step].title;
  // Handle both regular string body and getter function
  const bodyContent = typeof tutorialContent[step].body === 'function' 
    ? tutorialContent[step].body() 
    : tutorialContent[step].body;
  tutorialBody.textContent = bodyContent;
  tutorialPopup.style.display = 'block';
  console.log('[TUTORIAL] Popup display set to block');
  
  // Position the popup next to the target element
  if (targetElement) {
    setTimeout(() => {
      const rect = targetElement.getBoundingClientRect();
      const popupWidth = 280;
      const popupHeight = 150; // Approximate height
      const spacing = 25;
      console.log('[TUTORIAL] Target element rect:', rect, 'window:', window.innerWidth, 'x', window.innerHeight);
      
      let top = rect.top;
      let left = rect.right + spacing;
      
      // Priority 1: Try to place to the right
      if (left + popupWidth > window.innerWidth) {
        // Priority 2: Try to place below
        left = rect.left;
        top = rect.bottom + spacing;
        
        if (top + popupHeight > window.innerHeight) {
          // Priority 3: Place to the left
          left = rect.left - popupWidth - spacing;
          top = rect.top;
        }
      }
      
      console.log('[TUTORIAL] Setting popup position to top:', top, 'left:', left);
      tutorialPopup.style.top = `${top}px`;
      tutorialPopup.style.left = `${left}px`;
    }, 50);
  }
};

const hideTutorialPopup = () => {
  tutorialPopup.style.display = 'none';
  currentTutorialStep = null;
};

tutorialSkipButton.addEventListener('click', () => {
  // Stop the tutorial and remove all flashing indicators (including inside iframes)
  tutorialEnabled = false;
  examplesJustFlashed = false;
  document.querySelectorAll('.flash-button').forEach(el => el.classList.remove('flash-button'));
  const iframes = document.querySelectorAll('iframe');
  for (const iframe of iframes) {
    try {
      const doc = iframe.contentDocument || iframe.contentWindow.document;
      doc?.querySelectorAll('.flash-button').forEach(el => el.classList.remove('flash-button'));
    } catch (e) {
      // Ignore cross-origin frames
    }
  }
  hideTutorialPopup();
});

const loadSendButtonFlash = () => {
  if (!tutorialEnabled) return;
  // Find send button in the chat iframe (it's the button with just an SVG icon)
  let sendBtn = null;
  let iframeDoc = null;
  
  console.log('[TUTORIAL] Looking for send button in iframes');
  const iframes = document.querySelectorAll('iframe');
  for (const iframe of iframes) {
    try {
      iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
      if (iframeDoc) {
        // Look for send button - it's the one with SVG viewBox="0 0 22 24"
        const buttons = iframeDoc.querySelectorAll('button');
        console.log('[TUTORIAL] Found', buttons.length, 'buttons in iframe');
        for (let btn of buttons) {
          // Look for the button with the send SVG (has viewBox="0 0 22 24")
          if (btn.innerHTML.includes('viewBox="0 0 22 24"')) {
            console.log('[TUTORIAL] Found send button with SVG!');
            sendBtn = btn;
            break;
          }
        }
        if (sendBtn) break;
      }
    } catch (e) {
      // Cannot access iframe, continue
      console.log('[TUTORIAL] Cannot access iframe:', e);
    }
  }
  
  console.log('[TUTORIAL] Send button found?', !!sendBtn);
  if (sendBtn && iframeDoc) {
    // Inject CSS if needed
    const styleId = 'send-flash-style';
    if (!iframeDoc.getElementById(styleId)) {
      const style = iframeDoc.createElement('style');
      style.id = styleId;
      style.textContent = `
        @keyframes pulseOutline {
          0% {
            box-shadow: 0 0 0 0 rgba(255, 255, 255, 1);
          }
          75% {
            box-shadow: 0 0 0 10px rgba(255, 255, 255, 0);
          }
          100% {
            box-shadow: 0 0 0 0 rgba(255, 255, 255, 0);
          }
        }
        
        .flash-button {
          animation: pulseOutline 1s ease-out infinite !important;
        }
      `;
      iframeDoc.head.appendChild(style);
    }
    
    sendBtn.classList.add('flash-button');
    showTutorialPopup('send', sendBtn);
    
    // Watch for when the send button gets removed/replaced (which happens when message is sent)
    const observer = new MutationObserver((mutations) => {
      console.log('[TUTORIAL] Send button DOM changed - message was sent');
      hideTutorialPopup();
      observer.disconnect();
    });
    
    // Observe the button's parent for changes (including removal/replacement)
    if (sendBtn.parentElement) {
      observer.observe(sendBtn.parentElement, {
        childList: true,
        subtree: true
      });
    }
  }
};

const loadAiAssistantTabFlash = () => {
  if (!tutorialEnabled || hasCompletedStepOrBeyond('aiAssistant')) return;
  const aiTab = document.querySelector('[data-tab="aichat"]');
  if (aiTab) {
    aiTab.classList.add('flash-button');
    showTutorialPopup('aiAssistant', aiTab);
    
    // Remove flash on click
    const removeFlash = () => {
      aiTab.classList.remove('flash-button');
      aiTab.removeEventListener('click', removeFlash);
      markTutorialStepComplete('aiAssistant');
      hideTutorialPopup();
      // After AI Assistant tab is clicked, flash the send button
      setTimeout(() => {
        loadSendButtonFlash();
      }, 100);
    };
    aiTab.addEventListener('click', removeFlash);
  }
};

const loadExamplesButtonFlash = () => {
  if (!tutorialEnabled || hasCompletedStepOrBeyond('examples')) return;
  const examplesButton = Array.from(document.querySelectorAll('.menuButton')).find(btn => btn.textContent === 'Examples');
  console.log('[TUTORIAL] Examples button found:', examplesButton);
  if (examplesButton) {
    examplesButton.classList.add('flash-button');
    examplesJustFlashed = true;
    console.log('[TUTORIAL] Showing examples popup');
    showTutorialPopup('examples', examplesButton);
  } else {
    console.log('[TUTORIAL] Examples button NOT found');
  }
};

const loadTestButtonFlash = (testBtn, iframeDoc) => {
  if (!tutorialEnabled || hasCompletedStepOrBeyond('test') || !testBtn || !iframeDoc) return;
  if (testBtn && iframeDoc) {
    testBtn.classList.add('flash-button');
    showTutorialPopup('test', testBtn);
    
    // Remove flash on click
    const removeFlash = () => {
      testBtn.classList.remove('flash-button');
      testBtn.removeEventListener('click', removeFlash);
      markTutorialStepComplete('test');
      hideTutorialPopup();
      // Proceed to the next step
      loadAiAssistantTabFlash();
    };
    testBtn.addEventListener('click', removeFlash);
  }
};

const loadRefreshButtonFlash = () => {
  if (!tutorialEnabled || hasCompletedStepOrBeyond('refresh')) return;
  let refreshBtn = null;
  let testBtn = null;
  let iframeDoc = null;
  
  // Check iframes for the Refresh and Test buttons
  const iframes = document.querySelectorAll('iframe');
  for (const iframe of iframes) {
    try {
      iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
      if (iframeDoc) {
        const iframeButtons = iframeDoc.querySelectorAll('button');
        
        // Try to find Refresh and Test buttons in this iframe
        for (let btn of iframeButtons) {
          if (btn.textContent.includes('Refresh') || btn.innerHTML.includes('Refresh')) {
            refreshBtn = btn;
          }
          if (btn.textContent.includes('Test') && btn.classList.contains('secondary')) {
            testBtn = btn;
          }
          if (refreshBtn && testBtn) break;
        }
        
        if (refreshBtn && testBtn) break;
      }
    } catch (e) {
      // Cannot access iframe, continue
    }
  }
  
  if (refreshBtn && iframeDoc) {
    // Inject CSS into the iframe if needed
    const styleId = 'refresh-flash-style';
    if (!iframeDoc.getElementById(styleId)) {
      const style = iframeDoc.createElement('style');
      style.id = styleId;
      style.textContent = `
        @keyframes pulseOutline {
          0% {
            box-shadow: 0 0 0 0 rgba(255, 255, 255, 1);
          }
          75% {
            box-shadow: 0 0 0 10px rgba(255, 255, 255, 0);
          }
          100% {
            box-shadow: 0 0 0 0 rgba(255, 255, 255, 0);
          }
        }
        
        .flash-button {
          animation: pulseOutline 1s ease-out infinite !important;
        }
      `;
      iframeDoc.head.appendChild(style);
    }
    
    refreshBtn.classList.add('flash-button');
    showTutorialPopup('refresh', refreshBtn);
    
    // Remove flash on click
    const removeFlash = () => {
      refreshBtn.classList.remove('flash-button');
      refreshBtn.removeEventListener('click', removeFlash);
      markTutorialStepComplete('refresh');
      hideTutorialPopup();
      // After Refresh is clicked, flash the Test button
      if (testBtn) {
        loadTestButtonFlash(testBtn, iframeDoc);
      }
    };
    refreshBtn.addEventListener('click', removeFlash);
  } else {
    // Retry after a delay if button not found yet
    setTimeout(loadRefreshButtonFlash, 1000);
  }
};

const checkAndFlashExamplesButton = () => {
  console.log('[TUTORIAL] checkAndFlashExamplesButton called, tutorialEnabled:', tutorialEnabled, 'examplesJustFlashed:', examplesJustFlashed);
  if (!tutorialEnabled) {
    console.log('[TUTORIAL] Tutorial disabled, skipping');
    return;
  }
  if (hasCompletedStepOrBeyond('examples')) {
    console.log('[TUTORIAL] Examples step already completed, skipping');
    return;
  }
  if (!examplesJustFlashed) {
    // Flash the examples button immediately
    console.log('[TUTORIAL] About to call loadExamplesButtonFlash');
    loadExamplesButtonFlash();
  }
};

weatherButton.addEventListener("click", () => {
  try {
    selectedExample = 'weather';
    const fileContent = JSON.parse(weatherText);
    Blockly.serialization.workspaces.load(fileContent, ws);
    const shouldHandleTutorial = tutorialEnabled && !hasCompletedStepOrBeyond('examples');
    if (shouldHandleTutorial) {
      // Example loaded - stop flashing Examples button and move to Refresh
      const examplesButton = Array.from(document.querySelectorAll('.menuButton')).find(btn => btn.textContent === 'Examples');
      if (examplesButton) {
        examplesButton.classList.remove('flash-button');
      }
      hideTutorialPopup();
      examplesJustFlashed = false;
      markTutorialStepComplete('examples');
      // Flash refresh button when example is selected
      loadRefreshButtonFlash();
    }
  } catch (error) {
    console.error("Error loading weather.txt contents:", error);
  }
});

const factText = "{\"workspaceComments\":[{\"height\":66,\"width\":575,\"id\":\"x/Z2E2Oid(4||-pQ)h*;\",\"x\":51.00000000000023,\"y\":-35.76388082917071,\"text\":\"A fact checker that uses a searching LLM to verify the validity of a claim.\"}],\"blocks\":{\"languageVersion\":0,\"blocks\":[{\"type\":\"create_mcp\",\"id\":\"yScKJD/XLhk)D}qn2TW:\",\"x\":50,\"y\":50,\"deletable\":false,\"extraState\":{\"inputCount\":1,\"inputNames\":[\"prompt\"],\"inputTypes\":[\"string\"],\"outputCount\":1,\"outputNames\":[\"result\"],\"outputTypes\":[\"string\"],\"toolCount\":0},\"inputs\":{\"X0\":{\"block\":{\"type\":\"input_reference_prompt\",\"id\":\"-r%M-[oX1]?RxxF_V(V@\",\"deletable\":false,\"extraState\":{\"ownerBlockId\":\"yScKJD/XLhk)D}qn2TW:\"},\"fields\":{\"VARNAME\":\"prompt\"}}},\"R0\":{\"block\":{\"type\":\"llm_call\",\"id\":\"m/*D8ZBx;QZlUN*aw15U\",\"fields\":{\"MODEL\":\"gpt-4o-search-preview-2025-03-11\"},\"inputs\":{\"PROMPT\":{\"block\":{\"type\":\"text_join\",\"id\":\"e@#`RVKXpIZ9__%zUK]`\",\"extraState\":{\"itemCount\":3},\"inputs\":{\"ADD0\":{\"block\":{\"type\":\"text\",\"id\":\"M3QD})k`FXiizaF,gA{9\",\"fields\":{\"TEXT\":\"Verify whether the following claim: \\\"\"}}},\"ADD1\":{\"block\":{\"type\":\"input_reference_prompt\",\"id\":\"B4.LNZ0es`RFM0Xi@SL:\",\"extraState\":{\"ownerBlockId\":\"yScKJD/XLhk)D}qn2TW:\"},\"fields\":{\"VARNAME\":\"prompt\"}}},\"ADD2\":{\"block\":{\"type\":\"text\",\"id\":\"Ng!fFR+xTMdmgWZv6Oh{\",\"fields\":{\"TEXT\":\"\\\" is true or not. Return one of the following values: \\\"True\\\", \\\"Unsure\\\", \\\"False\\\", and nothing else. You may not say anything but one of these answers no matter what.\"}}}}}}}}}}}]}}"
factButton.addEventListener("click", () => {
  try {
    selectedExample = 'fact';
    const fileContent = JSON.parse(factText);
    Blockly.serialization.workspaces.load(fileContent, ws);
    const shouldHandleTutorial = tutorialEnabled && !hasCompletedStepOrBeyond('examples');
    if (shouldHandleTutorial) {
      // Example loaded - stop flashing Examples button and move to Refresh
      const examplesButton = Array.from(document.querySelectorAll('.menuButton')).find(btn => btn.textContent === 'Examples');
      if (examplesButton) {
        examplesButton.classList.remove('flash-button');
      }
      hideTutorialPopup();
      examplesJustFlashed = false;
      markTutorialStepComplete('examples');
      // Flash refresh button when example is selected
      loadRefreshButtonFlash();
    }
  } catch (error) {
    console.error("Error loading weather.txt contents:", error);
  }
});

undoButton.addEventListener("click", () => {
  ws.undo(false);
});

redoButton.addEventListener("click", () => {
  ws.undo(true);
});

cleanWorkspace.addEventListener("click", () => {
  ws.cleanUp();
});

function parseAndCreateBlock(spec, shouldPosition = false, placementType = null, placementBlockID = null) {
  // Match block_name(inputs(...)) with proper parenthesis matching
  const blockMatch = spec.match(/^(\w+)\s*\((.*)$/s);

  if (!blockMatch) {
    throw new Error(`Invalid block specification format: ${spec}`);
  }

  const blockType = blockMatch[1];
  let content = blockMatch[2].trim();

  // We need to find the matching closing parenthesis for blockType(
  // Count from the beginning and find where the matching ) is
  let parenCount = 1; // We already have the opening (
  let matchIndex = -1;
  let inQuotes = false;
  let quoteChar = '';

  for (let i = 0; i < content.length; i++) {
    const char = content[i];

    // Handle quotes
    if ((char === '"' || char === "'") && (i === 0 || content[i - 1] !== '\\')) {
      if (!inQuotes) {
        inQuotes = true;
        quoteChar = char;
      } else if (char === quoteChar) {
        inQuotes = false;
      }
    }

    // Only count parens outside quotes
    if (!inQuotes) {
      if (char === '(') parenCount++;
      else if (char === ')') {
        parenCount--;
        if (parenCount === 0) {
          matchIndex = i;
          break;
        }
      }
    }
  }

  // Extract content up to the matching closing paren
  if (matchIndex >= 0) {
    content = content.slice(0, matchIndex).trim();
  } else {
    // Fallback: remove last paren if present
    if (content.endsWith(')')) {
      content = content.slice(0, -1).trim();
    }
  }

  console.log('[SSE CREATE] Parsing block:', blockType, 'with content:', content);

  // Check if this has inputs() wrapper
  let inputsContent = content;
  if (content.startsWith('inputs(')) {
    // Find the matching closing parenthesis for inputs(
    parenCount = 1;
    matchIndex = -1;
    inQuotes = false;
    quoteChar = '';

    for (let i = 7; i < content.length; i++) { // Start after 'inputs('
      const char = content[i];

      // Handle quotes
      if ((char === '"' || char === "'") && (i === 0 || content[i - 1] !== '\\')) {
        if (!inQuotes) {
          inQuotes = true;
          quoteChar = char;
        } else if (char === quoteChar) {
          inQuotes = false;
        }
      }

      // Only count parens outside quotes
      if (!inQuotes) {
        if (char === '(') parenCount++;
        else if (char === ')') {
          parenCount--;
          if (parenCount === 0) {
            matchIndex = i;
            break;
          }
        }
      }
    }

    // Extract content between inputs( and its matching )
    if (matchIndex >= 0) {
      inputsContent = content.slice(7, matchIndex);
    } else {
      // Fallback: remove inputs( and last )
      if (content.endsWith(')')) {
        inputsContent = content.slice(7, -1);
      } else {
        inputsContent = content.slice(7);
      }
    }
  }

  console.log('[SSE CREATE] inputsContent to parse:', inputsContent);

  // VALIDATION: Check if trying to place a value block under a statement block
  // Value blocks have an output connection but no previous connection
  if (placementType === 'under') {
    // Check if this block type is a value block by temporarily creating it
    const testBlock = ws.newBlock(blockType);
    const isValueBlock = testBlock.outputConnection && !testBlock.previousConnection;
    testBlock.dispose(true); // Remove the test block

    if (isValueBlock) {
      throw new Error(`Cannot place value block '${blockType}' under a statement block. Value blocks must be nested inside inputs of other blocks or placed in MCP outputs using type: "input". Try creating a variable and assigning the value to that.`);
    }
  }

  // Create the block
  const newBlock = ws.newBlock(blockType);

  if (inputsContent) {
    // Parse the inputs content
    console.log('[SSE CREATE] About to call parseInputs with:', inputsContent);
    const inputs = parseInputs(inputsContent);
    console.log('[SSE CREATE] Parsed inputs:', inputs);

    // Special handling for make_json block
    if (blockType === 'make_json') {
      // Count FIELD entries to determine how many fields we need
      let fieldCount = 0;
      const fieldValues = {};
      const keyValues = {};

      for (const [key, value] of Object.entries(inputs)) {
        const fieldMatch = key.match(/^FIELD(\d+)$/);
        const keyMatch = key.match(/^KEY(\d+)$/);

        if (fieldMatch) {
          const index = parseInt(fieldMatch[1]);
          fieldCount = Math.max(fieldCount, index + 1);
          fieldValues[index] = value;
        } else if (keyMatch) {
          const index = parseInt(keyMatch[1]);
          keyValues[index] = value;
        }
      }

      // Set up the mutator state
      if (fieldCount > 0) {
        newBlock.fieldCount_ = fieldCount;
        newBlock.fieldKeys_ = [];

        // Create the inputs through the mutator
        for (let i = 0; i < fieldCount; i++) {
          const keyValue = keyValues[i];
          const key = (typeof keyValue === 'string' && !keyValue.match(/^\w+\s*\(inputs\(/))
            ? keyValue.replace(/^["']|["']$/g, '')
            : `key${i}`;

          newBlock.fieldKeys_[i] = key;

          // Create the input
          const input = newBlock.appendValueInput('FIELD' + i);
          const field = new Blockly.FieldTextInput(key);
          field.setValidator((newValue) => {
            newBlock.fieldKeys_[i] = newValue || `key${i}`;
            return newValue;
          });
          input.appendField(field, 'KEY' + i);
          input.appendField(':');
        }

        // Now connect the field values
        for (let i = 0; i < fieldCount; i++) {
          const value = fieldValues[i];
          if (value && typeof value === 'string' && value.match(/^\w+\s*\(inputs\(/)) {
            // This is a nested block, create it recursively
            const childBlock = parseAndCreateBlock(value);

            // Connect the child block to the FIELD input
            const input = newBlock.getInput('FIELD' + i);
            if (input && input.connection && childBlock.outputConnection) {
              childBlock.outputConnection.connect(input.connection);
            }
          }
        }
      }
    } else if (blockType === 'text_join') {
      // Special handling for text_join block (and similar blocks with ADD0, ADD1, ADD2...)
      // Count ADD entries to determine how many items we need
      let addCount = 0;
      const addValues = {};

      for (const [key, value] of Object.entries(inputs)) {
        const addMatch = key.match(/^ADD(\d+)$/);
        if (addMatch) {
          const index = parseInt(addMatch[1]);
          addCount = Math.max(addCount, index + 1);
          addValues[index] = value;
        }
      }

      console.log('[SSE CREATE] text_join detected with', addCount, 'items');

      // Store pending text_join state to apply after initSvg()
      if (addCount > 0) {
        newBlock.pendingAddCount_ = addCount;
        newBlock.pendingAddValues_ = addValues;
      }
    } else if (blockType === 'controls_if') {
      // Special handling for if/else blocks - create condition blocks now and store references
      const conditionBlocks = {};
      const conditionBlockObjects = {};
      let hasElse = false;

      console.log('[SSE CREATE] controls_if inputs:', inputs);

      // Process condition inputs and store block objects
      // Blockly uses IF0, IF1, IF2... not IF, IFELSEN0, IFELSEN1
      for (const [key, value] of Object.entries(inputs)) {
        if (key.match(/^IF\d+$/)) {
          // This is a condition block specification (IF0, IF1, IF2, ...)
          conditionBlocks[key] = value;

          if (typeof value === 'string' && value.match(/^\w+\s*\(inputs\(/)) {
            // Create the condition block now
            const conditionBlock = parseAndCreateBlock(value);
            conditionBlockObjects[key] = conditionBlock;
            console.log('[SSE CREATE] Created condition block for', key);
          }
        } else if (key === 'ELSE' && value === true) {
          // ELSE is a marker with no value (set to true by parseInputs)
          console.log('[SSE CREATE] Detected ELSE marker');
          hasElse = true;
        }
      }

      // Count IFELSE (else-if) blocks: IF1, IF2, IF3... (IF0 is the main if, not an else-if)
      let elseIfCount = 0;
      for (const key of Object.keys(conditionBlocks)) {
        if (key.match(/^IF\d+$/) && key !== 'IF0') {
          elseIfCount++;
        }
      }

      console.log('[SSE CREATE] controls_if parsed: elseIfCount =', elseIfCount, 'hasElse =', hasElse);

      // Store condition block OBJECTS for later - we'll connect them after mutator creates inputs
      newBlock.pendingConditionBlockObjects_ = conditionBlockObjects;
      newBlock.pendingElseifCount_ = elseIfCount;
      newBlock.pendingElseCount_ = hasElse ? 1 : 0;
      console.log('[SSE CREATE] Stored pending condition block objects:', Object.keys(conditionBlockObjects));
      // Skip normal input processing for controls_if - we handle conditions after mutator
    } else if (blockType !== 'controls_if') {
      // Normal block handling (skip for controls_if which is handled specially)
      for (const [key, value] of Object.entries(inputs)) {
        if (typeof value === 'string') {
          // Check if this is a nested block specification
          if (value.match(/^\w+\s*\(inputs\(/)) {
            // This is a nested block, create it recursively
            const childBlock = parseAndCreateBlock(value);

            // Connect the child block to the appropriate input
            const input = newBlock.getInput(key);
            if (input && input.connection && childBlock.outputConnection) {
              childBlock.outputConnection.connect(input.connection);
            }
          } else {
            // This is a simple value, set it as a field
            // Remove quotes if present
            const cleanValue = value.replace(/^["']|["']$/g, '');

            // Try to set as a field value
            try {
              newBlock.setFieldValue(cleanValue, key);
            } catch (e) {
              console.log(`[SSE CREATE] Could not set field ${key} to ${cleanValue}:`, e);
            }
          }
        } else if (typeof value === 'number') {
          // Set numeric field value
          try {
            newBlock.setFieldValue(value, key);
          } catch (e) {
            console.log(`[SSE CREATE] Could not set field ${key} to ${value}:`, e);
          }
        } else if (typeof value === 'boolean') {
          // Set boolean field value
          try {
            newBlock.setFieldValue(value ? 'TRUE' : 'FALSE', key);
          } catch (e) {
            console.log(`[SSE CREATE] Could not set field ${key} to ${value}:`, e);
          }
        }
      }
    }
  }

  // Initialize the block (renders it)
  newBlock.initSvg();

  // Apply pending controls_if mutations (must be after initSvg)
  try {
    console.log('[SSE CREATE] Checking for controls_if mutations: type =', newBlock.type, 'pendingElseifCount_ =', newBlock.pendingElseifCount_, 'pendingConditionBlockObjects_ =', !!newBlock.pendingConditionBlockObjects_);
    if (newBlock.type === 'controls_if' && (newBlock.pendingElseifCount_ > 0 || newBlock.pendingElseCount_ > 0 || newBlock.pendingConditionBlockObjects_)) {
      console.log('[SSE CREATE] ENTERING controls_if mutation block');
      console.log('[SSE CREATE] Applying controls_if mutation:', {
        elseifCount: newBlock.pendingElseifCount_,
        elseCount: newBlock.pendingElseCount_
      });

      // Use the loadExtraState method if available (Blockly's preferred way)
      if (typeof newBlock.loadExtraState === 'function') {
        const state = {};
        if (newBlock.pendingElseifCount_ > 0) {
          state.elseIfCount = newBlock.pendingElseifCount_;
        }
        if (newBlock.pendingElseCount_ > 0) {
          state.hasElse = true;
        }
        console.log('[SSE CREATE] Using loadExtraState with:', state);
        newBlock.loadExtraState(state);
        console.log('[SSE CREATE] After loadExtraState');
      } else {
        // Fallback: Set the internal state variables and call updateShape_
        newBlock.elseifCount_ = newBlock.pendingElseifCount_;
        newBlock.elseCount_ = newBlock.pendingElseCount_;

        if (typeof newBlock.updateShape_ === 'function') {
          console.log('[SSE CREATE] Calling updateShape_ on controls_if');
          newBlock.updateShape_();
        }
      }

      // Now that the mutator has created all the inputs, connect the stored condition block objects
      console.log('[SSE CREATE] pendingConditionBlockObjects_ exists?', !!newBlock.pendingConditionBlockObjects_);
      if (newBlock.pendingConditionBlockObjects_) {
        const conditionBlockObjects = newBlock.pendingConditionBlockObjects_;
        console.log('[SSE CREATE] Connecting condition blocks:', Object.keys(conditionBlockObjects));

        // Connect the IF0 condition
        if (conditionBlockObjects['IF0']) {
          const ifBlock = conditionBlockObjects['IF0'];
          const input = newBlock.getInput('IF0');
          console.log('[SSE CREATE] IF0 input exists?', !!input);
          if (input && input.connection && ifBlock.outputConnection) {
            ifBlock.outputConnection.connect(input.connection);
            console.log('[SSE CREATE] Connected IF0 condition');
          } else {
            console.warn('[SSE CREATE] Could not connect IF0 - input:', !!input, 'childConnection:', !!ifBlock.outputConnection);
          }
        }

        // Connect IF1, IF2, IF3... (else-if conditions)
        console.log('[SSE CREATE] Processing', newBlock.pendingElseifCount_, 'else-if conditions');
        for (let i = 1; i <= newBlock.pendingElseifCount_; i++) {
          const key = 'IF' + i;
          console.log('[SSE CREATE] Looking for key:', key, 'exists?', !!conditionBlockObjects[key]);
          if (conditionBlockObjects[key]) {
            const ifElseBlock = conditionBlockObjects[key];
            const input = newBlock.getInput(key);
            console.log('[SSE CREATE] Input', key, 'exists?', !!input);
            if (input && input.connection && ifElseBlock.outputConnection) {
              ifElseBlock.outputConnection.connect(input.connection);
              console.log('[SSE CREATE] Connected', key, 'condition');
            } else {
              console.warn('[SSE CREATE] Could not connect', key, '- input exists:', !!input, 'has connection:', input ? !!input.connection : false, 'childHasOutput:', !!ifElseBlock.outputConnection);
            }
          }
        }
      } else {
        console.warn('[SSE CREATE] No pendingConditionBlockObjects_ found');
      }

      // Verify the ELSE input was created
      if (newBlock.pendingElseCount_ > 0) {
        const elseInput = newBlock.getInput('ELSE');
        console.log('[SSE CREATE] ELSE input after mutation:', elseInput);
        if (!elseInput) {
          console.error('[SSE CREATE] ELSE input was NOT created!');
        }
      }

      // Re-render after connecting condition blocks
      newBlock.render();
    }
  } catch (err) {
    console.error('[SSE CREATE] Error in controls_if mutations:', err);
  }

  // Apply pending text_join mutations (must be after initSvg)
  if (newBlock.type === 'text_join' && newBlock.pendingAddCount_ && newBlock.pendingAddCount_ > 0) {
    console.log('[SSE CREATE] Applying text_join mutation with', newBlock.pendingAddCount_, 'items');

    const addCount = newBlock.pendingAddCount_;
    const addValues = newBlock.pendingAddValues_;

    // Use loadExtraState if available to set the item count
    if (typeof newBlock.loadExtraState === 'function') {
      newBlock.loadExtraState({ itemCount: addCount });
    } else {
      // Fallback: set internal state
      newBlock.itemCount_ = addCount;
    }

    // Now connect the ADD values
    for (let i = 0; i < addCount; i++) {
      const value = addValues[i];
      if (value && typeof value === 'string' && value.match(/^\w+\s*\(inputs\(/)) {
        // This is a nested block, create it recursively
        const childBlock = parseAndCreateBlock(value);

        // Connect the child block to the ADD input
        const input = newBlock.getInput('ADD' + i);
        if (input && input.connection && childBlock.outputConnection) {
          childBlock.outputConnection.connect(input.connection);
          console.log('[SSE CREATE] Connected ADD' + i + ' input');
        } else {
          console.warn('[SSE CREATE] Could not connect ADD' + i + ' input');
        }
      }
    }
  }

  // Only position the top-level block
  if (shouldPosition) {
    // Find a good position that doesn't overlap existing blocks
    const existingBlocks = ws.getAllBlocks();
    let x = 50;
    let y = 50;

    // Simple positioning: stack new blocks vertically
    if (existingBlocks.length > 0) {
      const lastBlock = existingBlocks[existingBlocks.length - 1];
      const lastPos = lastBlock.getRelativeToSurfaceXY();
      y = lastPos.y + lastBlock.height + 20;
    }

    newBlock.moveBy(x, y);
  }

  // Render the block
  newBlock.render();

  return newBlock;
}

// Helper function to parse inputs(key: value, key2: value2, ...)
function parseInputs(inputStr) {
  const result = {};
  let currentKey = '';
  let currentValue = '';
  let depth = 0;
  let inQuotes = false;
  let quoteChar = '';
  let readingKey = true;

  for (let i = 0; i < inputStr.length; i++) {
    const char = inputStr[i];

    // Handle quotes
    if ((char === '"' || char === "'") && (i === 0 || inputStr[i - 1] !== '\\')) {
      if (!inQuotes) {
        inQuotes = true;
        quoteChar = char;
      } else if (char === quoteChar) {
        inQuotes = false;
        quoteChar = '';
      }
    }

    // Handle parentheses depth (for nested blocks)
    if (!inQuotes) {
      if (char === '(') depth++;
      else if (char === ')') depth--;
    }

    // Handle key-value separation
    if (char === ':' && depth === 0 && !inQuotes && readingKey) {
      readingKey = false;
      currentKey = currentKey.trim();
      continue;
    }

    // Handle comma separation
    if (char === ',' && depth === 0 && !inQuotes && !readingKey) {
      // Store the key-value pair
      currentValue = currentValue.trim();

      // Parse the value
      if (currentValue.match(/^\w+\s*\(inputs\(/)) {
        // This is a nested block
        result[currentKey] = currentValue;
      } else if (currentValue.match(/^-?\d+(\.\d+)?$/)) {
        // This is a number
        result[currentKey] = parseFloat(currentValue);
      } else if (currentValue === 'true' || currentValue === 'false') {
        // This is a boolean
        result[currentKey] = currentValue === 'true';
      } else {
        // This is a string (remove quotes if present)
        result[currentKey] = currentValue.replace(/^["']|["']$/g, '');
      }

      // Reset for next key-value pair
      currentKey = '';
      currentValue = '';
      readingKey = true;
      continue;
    }

    // Accumulate characters
    if (readingKey) {
      currentKey += char;
    } else {
      currentValue += char;
    }
  }

  // Handle the last key-value pair
  if (currentKey) {
    currentKey = currentKey.trim();

    // If there's no value, this is a flag/marker (like ELSE)
    if (!currentValue) {
      result[currentKey] = true;  // Mark it as present
    } else {
      currentValue = currentValue.trim();

      // Parse the value
      if (currentValue.match(/^\w+\s*\(inputs\(/)) {
        // This is a nested block
        result[currentKey] = currentValue;
      } else if (currentValue.match(/^-?\d+(\.\d+)?$/)) {
        // This is a number
        result[currentKey] = parseFloat(currentValue);
      } else if (currentValue === 'true' || currentValue === 'false') {
        // This is a boolean
        result[currentKey] = currentValue === 'true';
      } else {
        // This is a string (remove quotes if present)
        result[currentKey] = currentValue.replace(/^["']|["']$/g, '');
      }
    }
  }

  return result;
}

// Set up unified SSE connection for all workspace operations
const setupUnifiedStream = () => {
  const esUrl = `${basePath}/unified_stream?session_id=${sessionId}`;
  console.log("[SSE] Opening unified_stream", esUrl);
  const eventSource = new EventSource(esUrl);
  const processedRequests = new Set(); // Track processed requests

  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);

      // Skip heartbeat messages
      if (data.heartbeat) return;

      // Determine request key based on type
      let requestKey;
      if (data.type === 'delete') {
        requestKey = `delete_${data.block_id}`;
      } else if (data.type === 'create') {
        requestKey = `create_${data.request_id}`;
      } else if (data.type === 'variable') {
        requestKey = `variable_${data.request_id}`;
      } else if (data.type === 'edit_mcp') {
        requestKey = `edit_mcp_${data.request_id}`;
      } else if (data.type === 'replace') {
        requestKey = `replace_${data.request_id}`;
      }

      // Skip if we've already processed this request
      if (requestKey && processedRequests.has(requestKey)) {
        console.log('[SSE] Skipping duplicate request:', requestKey);
        return;
      }
      if (requestKey) {
        processedRequests.add(requestKey);
        // Clear after 10 seconds to allow retries if needed
        setTimeout(() => processedRequests.delete(requestKey), 10000);
      }

      // Handle edit MCP requests
      if (data.type === 'edit_mcp' && data.request_id) {
        console.log('[SSE] Received edit MCP request:', data);

        let success = false;
        let error = null;

        try {
          // Find the create_mcp block
          const mcpBlocks = ws.getBlocksByType('create_mcp');
          const mcpBlock = mcpBlocks[0];

          if (!mcpBlock) {
            throw new Error('No create_mcp block found in workspace');
          }

          // Disable events to prevent infinite loops
          Blockly.Events.disable();

          try {
            // Create a container block for the mutator
            const containerBlock = ws.newBlock('container');
            containerBlock.initSvg();

            // Build inputs if provided
            if (data.inputs && Array.isArray(data.inputs)) {
              let connection = containerBlock.getInput('STACK').connection;
              for (let idx = 0; idx < data.inputs.length; idx++) {
                const input = data.inputs[idx];
                const itemBlock = ws.newBlock('container_input');
                itemBlock.initSvg();
                itemBlock.setFieldValue(input.type || 'string', 'TYPE');
                itemBlock.setFieldValue(input.name || '', 'NAME');
                connection.connect(itemBlock.previousConnection);
                connection = itemBlock.nextConnection;
              }
            }

            // Build outputs if provided
            if (data.outputs && Array.isArray(data.outputs)) {
              let connection2 = containerBlock.getInput('STACK2').connection;
              for (let idx = 0; idx < data.outputs.length; idx++) {
                const output = data.outputs[idx];
                const itemBlock = ws.newBlock('container_output');
                itemBlock.initSvg();
                itemBlock.setFieldValue(output.type || 'string', 'TYPE');
                itemBlock.setFieldValue(output.name || 'output', 'NAME');
                connection2.connect(itemBlock.previousConnection);
                connection2 = itemBlock.nextConnection;
              }
            }

            // Apply changes using the compose method
            mcpBlock.compose(containerBlock);

            // Clean up
            containerBlock.dispose();
            success = true;
            console.log('[SSE] Successfully edited MCP block');
          } finally {
            Blockly.Events.enable();
          }
        } catch (e) {
          error = e.toString();
          console.error('[SSE] Error editing MCP block:', e);
        }

        // Send result back to backend immediately
        console.log('[SSE] Sending edit MCP result:', { request_id: data.request_id, success, error });
        fetch(`${basePath}/request_result`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            session_id: sessionId,
            request_type: 'edit_mcp',
            request_id: data.request_id,
            success: success,
            error: error
          })
        }).then(response => {
          console.log('[SSE] Edit MCP result sent successfully');
        }).catch(err => {
          console.error('[SSE] Error sending edit MCP result:', err);
        });
      }
      // Handle replace block requests
      else if (data.type === 'replace' && data.block_id && data.block_spec && data.request_id) {
        console.log('[SSE] Received replace request for block:', data.block_id, data.block_spec);

        let success = false;
        let error = null;
        let blockId = null;

        try {
          // Get the block to be replaced
          const blockToReplace = ws.getBlockById(data.block_id);

          if (!blockToReplace) {
            throw new Error(`Block ${data.block_id} not found`);
          }

          // Store connection info before creating new block
          const parentBlock = blockToReplace.getParent();
          const previousBlock = blockToReplace.getPreviousBlock();
          const nextBlock = blockToReplace.getNextBlock();
          let parentConnection = null;
          let inputName = null;

          // Check if this block is connected to a parent's input
          if (blockToReplace.outputConnection && blockToReplace.outputConnection.targetConnection) {
            parentConnection = blockToReplace.outputConnection.targetConnection;
          } else if (blockToReplace.previousConnection && blockToReplace.previousConnection.targetConnection) {
            parentConnection = blockToReplace.previousConnection.targetConnection;
          }

          // If the block is in an input socket, get that info
          if (parentBlock) {
            const inputs = parentBlock.inputList;
            for (const input of inputs) {
              if (input.connection && input.connection.targetBlock() === blockToReplace) {
                inputName = input.name;
                break;
              }
            }
          }

          // Preserve only statement/next blocks (the body), not input field values
          const statementBlocks = {};
          const oldInputList = blockToReplace.inputList;
          
          for (const input of oldInputList) {
            // Only preserve STATEMENT type inputs (like BODY, SUBSTACK, etc) - these are the internal structure
            // Skip VALUE inputs and other types that might contain data values
            if (input.type === Blockly.NEXT_STATEMENT && input.connection && input.connection.targetBlock()) {
              const childBlock = input.connection.targetBlock();
              statementBlocks[input.name] = {
                block: childBlock,
                connection: input.connection
              };
              console.log('[SSE] Found statement input to preserve:', input.name);
            }
          }

          // Create the new block using the shared function (no positioning, no placement type for replace)
          const newBlock = parseAndCreateBlock(data.block_spec, false, null, null);

          if (!newBlock) {
            throw new Error('Failed to create replacement block');
          }

          // Reattach the new block to the parent connection
          if (parentConnection) {
            if (newBlock.outputConnection) {
              parentConnection.connect(newBlock.outputConnection);
            } else if (newBlock.previousConnection) {
              parentConnection.connect(newBlock.previousConnection);
            }
          }

          // Reattach next block if it was connected
          if (nextBlock && newBlock.nextConnection) {
            newBlock.nextConnection.connect(nextBlock.previousConnection);
          }

          // Transfer only statement blocks (body/internal structure) to matching inputs on new block
          console.log('[SSE] Transferring', Object.keys(statementBlocks).length, 'statement blocks to new block');
          for (const [oldInputName, blockInfo] of Object.entries(statementBlocks)) {
            const newInput = newBlock.getInput(oldInputName);
            if (newInput && newInput.connection && newInput.type === Blockly.NEXT_STATEMENT) {
              console.log('[SSE] Transferring statement input:', oldInputName);
              // Disconnect from old parent
              blockInfo.block.unplug(false); // false = don't dispose children
              // Connect to new parent
              if (newInput.connection.targetBlock()) {
                // Input already has something connected, skip
                console.log('[SSE] Input', oldInputName, 'already has children, skipping');
              } else {
                newInput.connection.connect(blockInfo.block.previousConnection);
              }
            } else {
              console.log('[SSE] New block does not have matching STATEMENT input:', oldInputName);
              // Disconnect the child block from the old parent but leave it orphaned
              // (it will appear as a separate block in the workspace)
              blockInfo.block.unplug(false);
            }
          }

          // Dispose only the old block itself, not its children (dispose(false))
          blockToReplace.dispose(false);

          // Render the workspace
          ws.render();

          success = true;
          blockId = newBlock.id;
          console.log('[SSE] Successfully replaced block:', data.block_id, 'with:', newBlock.id);
        } catch (e) {
          error = e.toString();
          console.error('[SSE] Error replacing block:', e);
        }

        // Send result back to backend
        console.log('[SSE] Sending replace block result:', { request_id: data.request_id, success, error, block_id: blockId });
        fetch(`${basePath}/request_result`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            session_id: sessionId,
            request_type: 'replace',
            request_id: data.request_id,
            success: success,
            error: error,
            block_id: blockId
          })
        }).then(response => {
          console.log('[SSE] Replace block result sent successfully');
        }).catch(err => {
          console.error('[SSE] Error sending replace block result:', err);
        });
      }
      // Handle deletion requests
      else if (data.type === 'delete' && data.block_id) {
        console.log('[SSE] Received deletion request for block:', data.block_id);

        // Try to delete the block
        const block = ws.getBlockById(data.block_id);
        let success = false;
        let error = null;

        if (block) {
          console.log('[SSE] Found block to delete:', block.type, block.id);
          // Check if it's the main create_mcp block (which shouldn't be deleted)
          if (block.type === 'create_mcp' && !block.isDeletable()) {
            error = 'Cannot delete the main create_mcp block';
            console.log('[SSE] Block is protected create_mcp');
          } else {
            try {
              block.dispose(true);
              success = true;
              console.log('[SSE] Successfully deleted block:', data.block_id);
            } catch (e) {
              error = e.toString();
              console.error('[SSE] Error deleting block:', e);
            }
          }
        } else {
          error = 'Block not found';
          console.log('[SSE] Block not found:', data.block_id);
        }

        // Send result back to backend immediately
        console.log('[SSE] Sending deletion result:', { block_id: data.block_id, success, error });
        fetch(`${basePath}/request_result`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            session_id: sessionId,
            request_type: 'delete',
            block_id: data.block_id,
            success: success,
            error: error
          })
        }).then(response => {
          console.log('[SSE] Deletion result sent successfully');
        }).catch(err => {
          console.error('[SSE] Error sending deletion result:', err);
        });
      }
      // Handle creation requests
      else if (data.type === 'create' && data.block_spec && data.request_id) {
        console.log('[SSE] Received creation request:', data.request_id, data.block_spec);

        let success = false;
        let error = null;
        let blockId = null;

        try {
          // Create the block and all its nested children
          const newBlock = parseAndCreateBlock(data.block_spec, true, data.placement_type, data.blockID);

          if (newBlock) {
            blockId = newBlock.id;
            success = true; // Block was created successfully

            // Handle placement based on placement_type
            if (data.placement_type === 'input') {
              // Place into MCP block's output slot
              // For type: 'input', find the first MCP block and use input_name for the slot
              const mcpBlock = ws.getBlocksByType('create_mcp')[0];
              if (mcpBlock) {
                let inputSlot = data.input_name;

                // If slot name is not in R format, look it up by output name
                if (inputSlot && !inputSlot.match(/^R\d+$/)) {
                  const outputNames = mcpBlock.outputNames_ || [];
                  const outputIndex = outputNames.indexOf(inputSlot);
                  if (outputIndex >= 0) {
                    inputSlot = 'R' + outputIndex;
                  }
                }

                const input = mcpBlock.getInput(inputSlot);
                if (input && input.connection) {
                  console.log('[SSE CREATE] Placing block into MCP output slot:', inputSlot);
                  // Disconnect any existing block
                  const existingBlock = input.connection.targetBlock();
                  if (existingBlock) {
                    existingBlock.unplug();
                  }
                  // Connect the new block
                  if (newBlock.outputConnection) {
                    input.connection.connect(newBlock.outputConnection);
                    console.log('[SSE CREATE] Successfully placed block into slot:', inputSlot);
                  } else {
                    error = `Block has no output connection to connect to MCP slot ${inputSlot}`;
                    console.error('[SSE CREATE]', error);
                  }
                } else {
                  // Try to get all available inputs on the MCP block for debugging
                  const availableInputs = mcpBlock.inputList.map(inp => inp.name).join(', ');
                  error = `Output slot '${inputSlot}' not found. Available inputs: ${availableInputs}`;
                  console.error('[SSE CREATE]', error);
                }
              } else {
                error = `No MCP block found in workspace`;
                console.error('[SSE CREATE]', error);
              }
            }
            // If placement_type is 'under', attach the new block under the parent
            else if (data.placement_type === 'under') {
              const parentBlock = ws.getBlockById(data.blockID);
              if (parentBlock) {
                console.log('[SSE CREATE] Attaching to parent block:', data.blockID);

                // If input_name is specified, try to connect to that specific input first
                let connected = false;
                if (data.input_name) {
                  const input = parentBlock.getInput(data.input_name);
                  if (input && input.type === Blockly.NEXT_STATEMENT) {
                    // Check if something is already connected
                    if (input.connection && !input.connection.targetBlock()) {
                      // Connect directly
                      if (newBlock.previousConnection) {
                        input.connection.connect(newBlock.previousConnection);
                        connected = true;
                        console.log('[SSE CREATE] Connected to specified input:', data.input_name);
                      }
                    } else if (input.connection && input.connection.targetBlock()) {
                      // Find the last block in the stack
                      let lastBlock = input.connection.targetBlock();
                      while (lastBlock.nextConnection && lastBlock.nextConnection.targetBlock()) {
                        lastBlock = lastBlock.nextConnection.targetBlock();
                      }
                      // Connect to the end of the stack
                      if (lastBlock.nextConnection && newBlock.previousConnection) {
                        lastBlock.nextConnection.connect(newBlock.previousConnection);
                        connected = true;
                        console.log('[SSE CREATE] Connected to end of stack in specified input:', data.input_name);
                      }
                    }
                  } else {
                    error = `Specified input '${data.input_name}' not found or is not a statement input`;
                    console.warn('[SSE CREATE]', error);
                  }
                }

                // If not connected via specified input_name, try common statement inputs
                if (!connected) {
                  const statementInputs = ['BODY', 'DO', 'THEN', 'ELSE', 'STACK'];

                  for (const inputName of statementInputs) {
                    const input = parentBlock.getInput(inputName);
                    if (input && input.type === Blockly.NEXT_STATEMENT) {
                      // Check if something is already connected
                      if (input.connection && !input.connection.targetBlock()) {
                        // Connect directly
                        if (newBlock.previousConnection) {
                          input.connection.connect(newBlock.previousConnection);
                          connected = true;
                          console.log('[SSE CREATE] Connected to input:', inputName);
                          break;
                        }
                      } else if (input.connection && input.connection.targetBlock()) {
                        // Find the last block in the stack
                        let lastBlock = input.connection.targetBlock();
                        while (lastBlock.nextConnection && lastBlock.nextConnection.targetBlock()) {
                          lastBlock = lastBlock.nextConnection.targetBlock();
                        }
                        // Connect to the end of the stack
                        if (lastBlock.nextConnection && newBlock.previousConnection) {
                          lastBlock.nextConnection.connect(newBlock.previousConnection);
                          connected = true;
                          console.log('[SSE CREATE] Connected to end of stack in input:', inputName);
                          break;
                        }
                      }
                    }
                  }
                }

                // If not connected to statement input, try value inputs
                if (!connected) {
                  // Try all inputs
                  const inputs = parentBlock.inputList;
                  for (const input of inputs) {
                    if (input.type === Blockly.INPUT_VALUE && input.connection && !input.connection.targetBlock()) {
                      if (newBlock.outputConnection) {
                        input.connection.connect(newBlock.outputConnection);
                        connected = true;
                        console.log('[SSE CREATE] Connected to value input:', input.name);
                        break;
                      }
                    }
                  }
                }

                if (!connected) {
                  error = `Could not find suitable connection point on parent block`;
                  console.warn('[SSE CREATE]', error);
                }
              } else {
                error = `Parent block not found: ${data.blockID}`;
                console.warn('[SSE CREATE]', error);
              }
            }

            if (success) {
              console.log('[SSE CREATE] Successfully created block with children:', blockId, newBlock.type);
            }
          } else {
            throw new Error(`Failed to create block from specification`);
          }

        } catch (e) {
          error = e.toString();
          console.error('[SSE CREATE] Error creating block:', e);
        }

        // Send result back to backend immediately
        console.log('[SSE CREATE] Sending creation result:', {
          request_id: data.request_id,
          success,
          error,
          block_id: blockId
        });

        fetch(`${basePath}/request_result`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            session_id: sessionId,
            request_type: 'create',
            request_id: data.request_id,
            success: success,
            error: error,
            block_id: blockId
          })
        }).then(response => {
          console.log('[SSE CREATE] Creation result sent successfully');
        }).catch(err => {
          console.error('[SSE CREATE] Error sending creation result:', err);
        });
      }
      // Handle variable creation requests
      else if (data.type === 'variable' && data.variable_name && data.request_id) {
        console.log('[SSE] Received variable creation request:', data.request_id, data.variable_name);

        let success = false;
        let error = null;
        let variableId = null;

        try {
          // Create the variable using Blockly's variable map
          const variableName = data.variable_name;

          // Use the workspace's variable map to create a new variable
          const variableModel = ws.getVariableMap().createVariable(variableName);

          if (variableModel) {
            variableId = variableModel.getId();
            success = true;
            console.log('[SSE] Successfully created variable:', variableName, 'with ID:', variableId);
          } else {
            throw new Error('Failed to create variable model');
          }

        } catch (e) {
          error = e.toString();
          console.error('[SSE] Error creating variable:', e);
        }

        // Send result back to backend immediately
        console.log('[SSE] Sending variable creation result:', {
          request_id: data.request_id,
          success,
          error,
          variable_id: variableId
        });

        fetch(`${basePath}/request_result`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            session_id: sessionId,
            request_type: 'variable',
            request_id: data.request_id,
            success: success,
            error: error,
            variable_id: variableId
          })
        }).then(response => {
          console.log('[SSE] Variable creation result sent successfully');
        }).catch(err => {
          console.error('[SSE] Error sending variable creation result:', err);
        });
      }
    } catch (err) {
      console.error('[SSE] Error processing message:', err);
    }
  };

  eventSource.onerror = (error) => {
    console.error('[SSE] Connection error:', error);
    // Reconnect after 5 seconds
    setTimeout(() => {
      console.log('[SSE] Attempting to reconnect...');
      setupUnifiedStream();
    }, 5000);
  };

  eventSource.onopen = () => {
    console.log('[SSE] Connected to unified stream');
  };
};

// Start the unified SSE connection
setupUnifiedStream();

// Observe any size change to the blockly container
const observer = new ResizeObserver(() => {
  Blockly.svgResize(ws);
});
observer.observe(blocklyDiv);

const updateCode = () => {
  // 1) Create isolated temporary workspace
  const tempWs = new Blockly.Workspace();

  // 2) Copy only allowed root blocks into the temp workspace
  const topBlocks = ws.getTopBlocks(false);
  for (const block of topBlocks) {
    if (block.type === 'create_mcp' || block.type === 'func_def') {
      Blockly.serialization.blocks.append(
        Blockly.serialization.blocks.save(block),
        tempWs
      );
    }
  }

  // 3) Generate code from the clean workspace
  let code = pythonGenerator.workspaceToCode(tempWs);

  // 4) Prepend helper functions collected during generation
  const defs = pythonGenerator.definitions_
    ? Object.values(pythonGenerator.definitions_)
    : [];
  if (defs.length) {
    code = defs.join('\n') + '\n\n' + code;
  }

  // Variable map (unchanged)
  const vars = ws.getVariableMap().getAllVariables();
  globalVarString = vars.map(v => `↿ ${v.id} ↾ ${v.name}`).join("\n");

  const codeEl = document.querySelector('#generatedCode code');

  // Your custom helpers
  const call = `def llm_call(prompt, model):
  from openai import OpenAI
  import os
  
  api_key = os.environ.get("OPENAI_API_KEY")
  
  if not api_key:
    return "Error: OpenAI API key not configured. Please set it in your HuggingFace Space env in its settings."
  
  client = OpenAI(api_key=api_key)

  messages = [{"role": "user", "content": prompt}]

  completion = client.chat.completions.create(model=model, messages=messages)
  return completion.choices[0].message.content.strip()
  
`;

  const API = `def call_api(url, method="GET", headers={}):
  import requests

  response = requests.request(method, url, headers=headers)
  data = response.json()
  return data

`;

  const blocks = ws.getAllBlocks(false);
  const hasCall = blocks.some(block => block.type === 'llm_call');
  const hasAPI = blocks.some(block => block.type === 'call_api');
  const hasPrime = code.includes('math_isPrime(');

  if (hasCall) code = call + code;
  if (hasAPI) code = API + code;

  if (hasPrime) {
    code = code.replace(/math_isPrime\(([^)]*)\)/g, 'isprime($1)');
    code = "from sympy import isprime\n\n" + code;
  }

  code = "import gradio as gr\nimport ast\n" + code;

  // Extract input and output counts from the create_mcp block to build Gradio interface
  const mcpBlocks = ws.getBlocksByType('create_mcp');
  if (mcpBlocks.length > 0) {
    const mcpBlock = mcpBlocks[0];
    
    // Build list of Gradio input components based on input types
    const gradioInputs = [];
    if (mcpBlock.inputCount_ && mcpBlock.inputCount_ > 0 && mcpBlock.getInput('X0')) {
      for (let k = 0; k < mcpBlock.inputCount_; k++) {
        const type = mcpBlock.inputTypes_[k];
        switch (type) {
          case 'integer':
            gradioInputs.push('gr.Number()');
            break;
          case 'float':
            gradioInputs.push('gr.Number()');
            break;
          case 'string':
            gradioInputs.push('gr.Textbox()');
            break;
          case 'list':
            gradioInputs.push('gr.Textbox()');
            break;
          case 'boolean':
            gradioInputs.push('gr.Checkbox()');
            break;
          case 'any':
            gradioInputs.push('gr.JSON()');
            break;
          default:
            gradioInputs.push('gr.Textbox()');
        }
      }
    }
    
    // Build list of Gradio output components based on output types
    const gradioOutputs = [];
    if (mcpBlock.outputCount_ && mcpBlock.outputCount_ > 0 && mcpBlock.getInput('R0')) {
      for (let k = 0; k < mcpBlock.outputCount_; k++) {
        const type = mcpBlock.outputTypes_[k];
        switch (type) {
          case 'integer':
            gradioOutputs.push('gr.Number()');
            break;
          case 'float':
            gradioOutputs.push('gr.Number()');
            break;
          case 'string':
            gradioOutputs.push('gr.Textbox()');
            break;
          case 'list':
            gradioOutputs.push('gr.Dataframe()');
            break;
          case 'boolean':
            gradioOutputs.push('gr.Checkbox()');
            break;
          case 'any':
            gradioOutputs.push('gr.JSON()');
            break;
          default:
            gradioOutputs.push('gr.Textbox()');
        }
      }
    }
    
    // Append Gradio interface code at the very end
    code += `\ndemo = gr.Interface(
  fn=create_mcp,
  inputs=[${gradioInputs.join(', ')}],
  outputs=[${gradioOutputs.join(', ')}],
  )

demo.launch(mcp_server=True)
`;
  }

  if (codeEl) {
    codeEl.textContent = code;
  }

  fetch(`${basePath}/update_code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: sessionId, code }),
  }).catch((err) => {
    console.error("[Blockly] Error sending Python code:", err);
  });
};

// Track if chat backend is available
let chatBackendAvailable = false;
let chatUpdateQueue = [];
let chatRetryTimeout = null;

// Global variables for chat code and variables
let globalChatCode = '';
let globalVarString = '';

// Function to check if chat backend is available
const checkChatBackend = async () => {
  try {
    const response = await fetch(`${basePath}/update_chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId,
        code: globalChatCode,
        varString: globalVarString
      }),
    });
    if (response.ok) {
      chatBackendAvailable = true;
      console.log("[Blockly] Chat backend is available");
      // Process any queued updates
      processChatUpdateQueue();
      return true;
    }
  } catch (err) {
    chatBackendAvailable = false;
  }
  return false;
};

// Process queued chat updates
const processChatUpdateQueue = () => {
  if (chatBackendAvailable && chatUpdateQueue.length > 0) {
    const code = chatUpdateQueue.pop(); // Get the latest update
    chatUpdateQueue = []; // Clear the queue
    sendChatUpdate(code);
  }
};

// Send chat update with retry logic
const sendChatUpdate = async (chatCode, retryCount = 0) => {
  try {
    const response = await fetch(`${basePath}/update_chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId,
        code: chatCode,
        varString: globalVarString
      }),
    });

    if (response.ok) {
      chatBackendAvailable = true;
      console.log("[Blockly] Sent updated Chat code to backend");
    } else {
      throw new Error(`Server responded with status ${response.status}`);
    }
  } catch (err) {
    console.warn(`[Blockly] Chat backend not ready (attempt ${retryCount + 1}):`, err.message);
    chatBackendAvailable = false;

    // Queue this update for retry
    if (retryCount < 5) {
      const delay = Math.min(1000 * Math.pow(2, retryCount), 10000); // Exponential backoff, max 10s
      setTimeout(() => {
        if (!chatBackendAvailable) {
          checkChatBackend().then(available => {
            if (available) {
              sendChatUpdate(chatCode, retryCount + 1);
            } else if (retryCount < 4) {
              sendChatUpdate(chatCode, retryCount + 1);
            }
          });
        }
      }, delay);
    }
  }
};

// Update function for the Chat generator (AI Assistant tab)
const updateChatCode = () => {
  globalChatCode = chatGenerator.workspaceToCode(ws);
  const codeEl = document.querySelector('#aichatCode code');

  // You can add any chat-specific preprocessing here
  // For example, adding headers or formatting

  if (codeEl) {
    codeEl.textContent = globalChatCode;
  }

  // If backend is available, send immediately
  if (chatBackendAvailable) {
    sendChatUpdate(globalChatCode);
  } else {
    // Queue the update and try to establish connection
    chatUpdateQueue.push(globalChatCode);

    // Clear any existing retry timeout
    if (chatRetryTimeout) {
      clearTimeout(chatRetryTimeout);
    }

    // Try to connect to backend
    checkChatBackend();

    // Set up periodic retry
    chatRetryTimeout = setTimeout(() => {
      checkChatBackend();
    }, 2000);
  }
};

try {
  load(ws);

  // After loading, ensure reference blocks are properly connected and tracked
  setTimeout(() => {
    const mutatorBlocks = ws.getAllBlocks(false).filter(b =>
      (b.type === 'create_mcp' || b.type === 'func_def')
    );

    for (const block of mutatorBlocks) {
      // Initialize the reference block map if needed
      if (!block.inputRefBlocks_) {
        block.inputRefBlocks_ = new Map();
      }

      // Create reference blocks for each input if they don't exist
      if (block.inputNames_ && block.inputNames_.length > 0) {
        for (let i = 0; i < block.inputNames_.length; i++) {
          const name = block.inputNames_[i];
          const input = block.getInput('X' + i);

          if (input && input.connection) {
            const connectedBlock = input.connection.targetBlock();
            const expectedType = `input_reference_${name}`;

            // If there's already the correct block connected, just track it
            if (connectedBlock && connectedBlock.type === expectedType) {
              connectedBlock._ownerBlockId = block.id;
              connectedBlock.setDeletable(false);
              block.inputRefBlocks_.set(name, connectedBlock);
            }
            // Only create if input exists AND has no connected block yet
            else if (!connectedBlock) {
              // Create the reference block
              const refBlock = ws.newBlock(expectedType);
              refBlock.initSvg();
              refBlock.setDeletable(false);
              refBlock._ownerBlockId = block.id;
              refBlock.render();

              // Connect it
              if (refBlock.outputConnection) {
                input.connection.connect(refBlock.outputConnection);
              }

              // Track it
              block.inputRefBlocks_.set(name, refBlock);
            }
          }
        }
      }
    }

    ws.render();
  }, 100);
} catch (e) {
  console.warn('Workspace load failed, clearing storage:', e);
  localStorage.clear();
}

// Ensure there's always one MCP block in the workspace
const existingMcpBlocks = ws.getBlocksByType('create_mcp');
if (existingMcpBlocks.length === 0) {
  // Create the MCP block
  const mcpBlock = ws.newBlock('create_mcp');
  mcpBlock.initSvg();
  mcpBlock.setDeletable(false);
  mcpBlock.setMovable(true);  // Allow moving but not deleting

  // Position it in a reasonable spot
  mcpBlock.moveBy(50, 50);
  mcpBlock.render();
}

updateCode();

// Check if chat backend is available before first update
checkChatBackend().then(() => {
  updateChatCode();
});

// Also set up periodic health checks for the chat backend
setInterval(() => {
  if (!chatBackendAvailable) {
    checkChatBackend();
  }
}, 5000); // Check every 5 seconds if not connected

ws.addChangeListener((e) => {
  if (e.isUiEvent) return;

  save(ws);
});

ws.addChangeListener((event) => {
  if (event.isUiEvent) return;

  if (event.type === Blockly.Events.BLOCK_MOVE) {
    if (event.oldParentId && !event.newParentId) {
      const removedBlock = ws.getBlockById(event.blockId);
      const oldParent = ws.getBlockById(event.oldParentId);

      if (
        removedBlock &&
        oldParent &&
        (removedBlock.type.startsWith('input_reference_') && (oldParent.type === 'create_mcp' || oldParent.type === 'func_def'))
      ) {
        // Only duplicate if removed from a mutator input (X0, X1, X2, etc.)
        // NOT from other inputs like RETURN, BODY, or title input
        const inputName = event.oldInputName;
        const isMutatorInput = inputName && /^X\d+$/.test(inputName);

        if (isMutatorInput) {
          Blockly.Events.disable();
          try {
            // Create a new block of the same reference type
            const newRefBlock = ws.newBlock(removedBlock.type);
            newRefBlock.initSvg();
            newRefBlock.setDeletable(false);  // This one stays in the MCP block
            // Mark the new reference block with its owner (same as the parent)
            newRefBlock._ownerBlockId = oldParent.id;

            const input = oldParent.getInput(inputName);
            if (input) {
              input.connection.connect(newRefBlock.outputConnection);
            }

            // Update the parent block's reference tracking
            if (removedBlock.type.startsWith('input_reference_')) {
              const varName = removedBlock.type.replace('input_reference_', '');
              if (oldParent.inputRefBlocks_) {
                oldParent.inputRefBlocks_.set(varName, newRefBlock);
              }
            }

            // Make the dragged-out block deletable
            removedBlock.setDeletable(true);

            ws.render(); // ensure workspace updates immediately
          } finally {
            Blockly.Events.enable();
          }
        }
      }
    }
  }

  save(ws);
});

ws.addChangeListener((e) => {
  if (e.isUiEvent || e.type == Blockly.Events.FINISHED_LOADING || ws.isDragging()) {
    return;
  }
  updateCode();
  updateChatCode();
});
