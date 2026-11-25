import { getContext } from "/scripts/extensions.js";
import { saveBase64AsFile } from "/scripts/utils.js";
import { humanizedDateTime } from "/scripts/RossAscends-mods.js";
import { addOneMessage, saveChat } from "/script.js";

const hostname = window.location.hostname;
const DEFAULT_COMFY_URL = `http://${hostname}:8188`;
const COMFY_URL_KEY = "deepgelbooru_comfy_url";
const REQUEST_TIMEOUT_MS = 180000;
const ANALYZE_NODE_ID = "35"; // Get result from Deduplicate Tags node (ID 35)

// Workflow for ANALYSIS (Both taggers + Concatenate)
const WORKFLOW_ANALYZE = {
    "28": { "inputs": { "image": "example.png" }, "class_type": "LoadImage" },
    "30": {
        "inputs": { "general_threshold": 0.35, "character_threshold": 0.45, "drop_overlap": false, "image": ["28", 0] },
        "class_type": "ImgUtilsDeepGelbooru"
    },
    "34": {
        "inputs": { "model_name": "wd-eva02-large-tagger-v3", "dtype": "auto", "general_threshold": 0.3, "character_threshold": 0.75, "add_rating": false, "exclude_tags": "", "batch_size": 4, "image": ["28", 0] },
        "class_type": "WDTimmTagger"
    },
    "37": {
        "inputs": { 
            "string_a": ["30", 0], 
            "string_b": ["34", 0], 
            "delimiter": ", " 
        },
        "class_type": "StringConcatenate"
    },
    "35": { 
        "inputs": { "tags": ["37", 0] }, 
        "class_type": "ImgUtilsDedup" 
    },
    "36": { 
        "inputs": { "source": ["35", 0] }, 
        "class_type": "PreviewAny" 
    }
};

function getComfyUrl() {
    const input = document.getElementById("dd-comfy-url");
    const saved = localStorage.getItem(COMFY_URL_KEY);
    const value = input?.value?.trim() || saved || DEFAULT_COMFY_URL;
    return value.replace(/\/+$/, "");
}

function setComfyUrl(value) {
    const normalized = value.trim().replace(/\/+$/, "");
    if (!normalized) throw new Error("Please specify ComfyUI address.");
    localStorage.setItem(COMFY_URL_KEY, normalized);
    const input = document.getElementById("dd-comfy-url");
    if (input) input.value = normalized;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } catch (error) {
        if (error.name === "AbortError") throw new Error(`Request timed out: ${url}`);
        throw error;
    } finally {
        clearTimeout(timer);
    }
}

async function getNodeInfo(nodeName) {
    const response = await fetchWithTimeout(`${getComfyUrl()}/object_info/${encodeURIComponent(nodeName)}`);
    if (!response.ok) throw new Error(`ComfyUI did not return data for node ${nodeName} (${response.status}).`);
    return response.json();
}

function getComboOptions(nodeInfo, nodeName, inputName) {
    const definition = nodeInfo?.[nodeName]?.input?.required?.[inputName];
    if (Array.isArray(definition?.[0])) return definition[0];
    if (Array.isArray(definition?.[1]?.options)) return definition[1].options;
    return [];
}

async function getAvailableCheckpoints() {
    try {
        const info = await getNodeInfo("CheckpointLoaderSimple");
        return getComboOptions(info, "CheckpointLoaderSimple", "ckpt_name");
    } catch (e) {
        return [];
    }
}

async function getAvailableLoras() {
    try {
        const info = await getNodeInfo("LoraLoader");
        return getComboOptions(info, "LoraLoader", "lora_name");
    } catch (error) {
        return [];
    }
}

function normalizeName(value) {
    return String(value ?? "").normalize("NFKC").replace(/\.[^.]+$/, "").toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

function getActiveCharacterName() {
    const context = getContext();
    const character = context.characters?.[context.characterId];
    return character?.name?.trim() || "";
}

async function findLoraForCharacter(characterName) {
    if (!characterName) return null;
    const wanted = normalizeName(characterName);
    const availableLoras = await getAvailableLoras();
    if (availableLoras.length === 0) return null;
    const mapped = availableLoras.map(file => {
        const basename = String(file).split(/[\\/]/).pop();
        return { file, key: normalizeName(basename) };
    });
    let matches = mapped.filter(entry => entry.key === wanted);
    if (matches.length === 0) matches = mapped.filter(entry => entry.key.startsWith(wanted));
    if (matches.length === 0) return null;
    if (matches.length > 1) throw new Error(`Multiple LoRAs found for "${characterName}".`);
    return matches[0].file;
}

function extractTriggerFromLora(loraFileName) {
    if (!loraFileName) return "";
    const basename = String(loraFileName).split(/[\\/]/).pop();
    return basename.replace(/\.(safetensors|ckpt)$/i, "").trim();
}

async function uploadImageToComfy(file) {
    const formData = new FormData();
    formData.append("image", file);
    formData.append("type", "input");
    formData.append("overwrite", "true");
    const response = await fetchWithTimeout(`${getComfyUrl()}/upload/image`, { method: "POST", body: formData });
    if (!response.ok) {
        const details = await response.text().catch(() => "");
        throw new Error(`Failed to upload image (${response.status}): ${details}`);
    }
    const data = await response.json();
    if (!data.name) throw new Error("ComfyUI did not return a filename.");
    return data.name;
}

async function queuePrompt(workflow, imageName) {
    const wf = JSON.parse(JSON.stringify(workflow));
    for (const key in wf) {
        if (wf[key].class_type === "LoadImage" && imageName) {
            wf[key].inputs.image = imageName;
        }
    }
    const response = await fetchWithTimeout(`${getComfyUrl()}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: wf })
    });
    if (!response.ok) {
        const details = await response.text().catch(() => "");
        throw new Error(`ComfyUI rejected workflow (${response.status}): ${details}`);
    }
    const data = await response.json();
    if (data.error) throw new Error(`Workflow error: ${JSON.stringify(data.error)}`);
    if (!data.prompt_id) throw new Error("ComfyUI did not return prompt_id.");
    return data.prompt_id;
}

async function waitForResult(promptId) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < REQUEST_TIMEOUT_MS) {
        const response = await fetchWithTimeout(`${getComfyUrl()}/history/${encodeURIComponent(promptId)}`, {}, 15000);
        if (!response.ok) throw new Error(`Failed to get result (${response.status}).`);
        const history = await response.json();
        const entry = history[promptId];
        if (entry) {
            const status = entry.status || {};
            if (status.status_str === "error") throw new Error(`ComfyUI error: ${JSON.stringify(status.messages || status)}`);
            if (status.completed === true || status.status_str === "success" || entry.outputs) return entry;
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error("Result wait timeout.");
}

function collectStrings(value, result = []) {
    if (typeof value === "string") { const text = value.trim(); if (text) result.push(text); return result; }
    if (Array.isArray(value)) { for (const item of value) collectStrings(item, result); return result; }
    if (value && typeof value === "object") { for (const item of Object.values(value)) collectStrings(item, result); }
    return result;
}

// Вспомогательная функция для нормализации одного тега
function normalizeTag(tag) {
    return tag.trim()
        .replace(/\s+/g, '_') // Заменяем пробелы на подчеркивания
        .replace(/:+/g, ':')  // Убираем двойные двоеточия
        .replace(/^_+|_+$/g, '') // Убираем подчеркивания в начале и конце
        .toLowerCase();
}

function extractTags(entry) {
    const outputs = entry?.outputs || {};
    let allText = "";
    
    // Собираем все строки в один текст
    const candidates = [...collectStrings(outputs[ANALYZE_NODE_ID]), ...collectStrings(outputs)];
    for (const text of candidates) {
        allText += text + ", ";
    }

    if (!allText.trim()) return null;

    // Разбиваем на отдельные теги по запятым
    const rawTags = allText.split(/[,，\n]/);
    const uniqueTags = new Set();

    // Ключевые слова, которые отправляем в КОНЕЦ
    const tailKeywords = ['hair', 'eyes', 'eyebrows', 'bangs', 'braid', 'twintails', 'ponytail', 'ahoge', 'nail', 'nails', 'nail_polish'];

    // Ключевые слова, которые УДАЛЯЕМ (мусор и цензура)
    const removeKeywords = [
        'artist', 'patreon', 'twitter', 'web_address', 'username', 'watermark', 'signature', 'logo', 'copyright',
        'censored', 'censor', 'mosaic', 'bar_censor', 'pixelated' // <-- Добавлены теги цензуры
    ];

    const normalTags = [];
    const tailTags = [];

    for (let tag of rawTags) {
        let cleanTag = normalizeTag(tag);
        if (!cleanTag) continue;
        
        // Убираем теги рейтинга
        if (cleanTag.startsWith('rating:')) continue;

        // Убираем мусорные теги и цензуру
        if (removeKeywords.some(keyword => cleanTag.includes(keyword))) continue;

        if (uniqueTags.has(cleanTag)) continue;
        uniqueTags.add(cleanTag);

        // Проверяем, относится ли тег к "хвосту" (волосы, глаза, ногти)
        if (tailKeywords.some(keyword => cleanTag.includes(keyword))) {
            tailTags.push(cleanTag);
        } else {
            normalTags.push(cleanTag);
        }
    }

    // Сортируем обычные теги по длине (чтобы длинные были впереди)
    normalTags.sort((a, b) => b.length - a.length);
    
    // Сортируем теги хвоста по алфавиту для удобства
    tailTags.sort();

    // Склеиваем: сначала обычные, потом хвост
    const finalTags = [...normalTags, ...tailTags];
    
    return finalTags.join(", ");
}

function findMessageTextarea() {
    return document.getElementById("send_textarea") || document.querySelector("textarea#send_textarea");
}

function insertTags(tags) {
    const textarea = findMessageTextarea();
    if (!textarea) throw new Error("SillyTavern input field not found.");
    const currentText = textarea.value || "";
    textarea.value = `${currentText}${currentText.trim() ? ", " : ""}${tags}`;
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.dispatchEvent(new Event("change", { bubbles: true }));
    textarea.focus();
}

function buildGenerateWorkflow({ tags, checkpoint, lora }) {
    const trigger = extractTriggerFromLora(lora);
    const manualPrompt = "smooth, absurdres, amazing quality, very aesthetic, perfect anatomy, intricate details";
    const positivePrompt = `${trigger ? trigger + ', ' : ''}${tags}, ${manualPrompt}`;

    const wf = {
        "23": { "inputs": { "ckpt_name": checkpoint }, "class_type": "CheckpointLoaderSimple" },
        "10": { "inputs": { "text": positivePrompt, "clip": ["23", 1] }, "class_type": "CLIPTextEncode" },
        "11": { "inputs": { "text": "bad quality, worst quality, worst detail, sketch, censor, text, watermark, bad anatomy, bad hands, missing fingers, extra digits, fewer digits, extra ears, duplicate, multiple limbs, deformed, disfigured, mutated, poorly drawn face, poorly drawn hands, poorly drawn feet", "clip": ["23", 1] }, "class_type": "CLIPTextEncode" },
        "13": { "inputs": { "width": 1024, "height": 1344, "batch_size": 1 }, "class_type": "EmptyLatentImage" },
        "18": { "inputs": { "add_noise": "enable", "noise_seed": Math.floor(Math.random() * 1125899906842624), "steps": 20, "cfg": 6, "sampler_name": "euler_ancestral", "scheduler": "normal", "start_at_step": 0, "end_at_step": 10000, "return_with_leftover_noise": "disable", "model": ["23", 0], "positive": ["10", 0], "negative": ["11", 0], "latent_image": ["13", 0] }, "class_type": "KSamplerAdvanced" },
        "19": { "inputs": { "samples": ["18", 0], "vae": ["23", 2] }, "class_type": "VAEDecode" },
        "20": { "inputs": { "filename_prefix": "SillyTavern/Gen", "format": "png", "format.bit_depth": "8-bit", "format.input_color_space": "sRGB", "images": ["19", 0] }, "class_type": "SaveImageAdvanced" }
    };

    if (lora) {
        wf["26"] = { 
            "inputs": { 
                "lora_name": lora, 
                "strength_model": 0.7, 
                "strength_clip": 0.7, 
                "model": ["23", 0], 
                "clip": ["23", 1] 
            }, 
            "class_type": "LoraLoader" 
        };
        wf["10"].inputs.clip = ["26", 1];
        wf["11"].inputs.clip = ["26", 1];
        wf["18"].inputs.model = ["26", 0];
    }

    return wf;
}

async function insertImageToChat(imageUrl, promptText) {
    try {
        if (window.toastr) toastr.info("Downloading image...");
        const response = await fetch(imageUrl);
        const blob = await response.blob();

        const reader = new FileReader();
        reader.readAsDataURL(blob);
        reader.onloadend = async function() {
            try {
                const base64FullURL = reader.result;
                const base64Raw = base64FullURL.split(',')[1];

                const context = getContext();
                let characterName = "User";
                if (context.groupId) {
                    characterName = context.groups.find(x => x.id === context.groupId)?.id || "Group";
                } else if (context.characterId) {
                    characterName = context.characters[context.characterId]?.name || "User";
                }
                
                const filename = `Variation_${humanizedDateTime().replace(/[^\w.-]/g, "_")}`;
                const savedPath = await saveBase64AsFile(base64Raw, characterName, filename, "png");

                const mediaAttachment = {
                    url: savedPath,
                    type: "image",
                    source: "generated",
                    title: promptText,
                    generation_type: "free",
                };

                const newMessage = {
                    name: "Ult_generation",
                    is_user: false,
                    is_system: true,
                    send_date: Date.now(),
                    mes: "",
                    extra: {
                        media: [mediaAttachment],
                        media_display: "gallery",
                        media_index: 0,
                        inline_image: false
                    },
                    force_avatar: "img/five.png"
                };

                context.chat.push(newMessage);
                await saveChat();
                
                if (typeof addOneMessage === "function") addOneMessage(newMessage);
                if (window.toastr) toastr.success("Image added to chat!");
            } catch (err) {
                console.error(err);
                if (window.toastr) toastr.error("Error saving image.");
                window.open(imageUrl, '_blank');
            }
        };
    } catch (e) {
        console.error(e);
        if (window.toastr) toastr.error("Failed to download image. Opening in new tab.");
        window.open(imageUrl, '_blank');
    }
}

function getGeneratedImageUrl(entry) {
    for (const output of Object.values(entry?.outputs || {})) {
        if (!Array.isArray(output.images) || output.images.length === 0) continue;
        const image = output.images[0];
        const params = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder || "", type: image.type || "output" });
        return `${getComfyUrl()}/view?${params}`;
    }
    return null;
}

function pickFile() {
    return new Promise((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "image/*";
        input.onchange = () => resolve(input.files?.[0] || null);
        input.click();
    });
}

// MODAL WINDOW (Absolute positioning to prevent mobile keyboard jumping)
function promptForText(title, placeholder = "Describe what you want to see...", initialValue = "") {
    return new Promise((resolve) => {
        const overlay = document.createElement("div");
        overlay.style.cssText = "position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(0,0,0,0.85); z-index: 99999; overflow-y: auto; -webkit-overflow-scrolling: touch;";

        const modal = document.createElement("div");
        modal.style.cssText = "position: relative; margin: 20px auto; width: 95%; max-width: 600px; background: #1a1a1a; padding: 15px; border-radius: 12px; display: flex; flex-direction: column; gap: 10px; box-shadow: 0 4px 15px rgba(0,0,0,0.5);";

        const header = document.createElement("h3");
        header.textContent = title;
        header.style.cssText = "margin: 0; color: white; font-size: 18px;";

        const textarea = document.createElement("textarea");
        textarea.placeholder = placeholder;
        textarea.value = initialValue;
        textarea.style.cssText = "min-height: 120px; padding: 10px; border-radius: 4px; border: 1px solid #333; background: #0a0a0a; color: white; resize: vertical; font-size: 16px; width: 100%; box-sizing: border-box;";

        const btnContainer = document.createElement("div");
        btnContainer.style.cssText = "display: flex; justify-content: flex-end; gap: 10px;";

        const cancelBtn = document.createElement("button");
        cancelBtn.textContent = "Cancel";
        cancelBtn.className = "menu_button";
        cancelBtn.onclick = () => { document.body.removeChild(overlay); resolve(null); };

        const okBtn = document.createElement("button");
        okBtn.textContent = "Generate";
        okBtn.className = "menu_button";
        okBtn.onclick = () => { document.body.removeChild(overlay); resolve(textarea.value.trim()); };

        btnContainer.append(cancelBtn, okBtn);
        modal.append(header, textarea, btnContainer);
        overlay.appendChild(modal);
        document.body.appendChild(overlay);
        
        setTimeout(() => textarea.focus(), 100);

        overlay.addEventListener("click", (e) => {
            if (e.target === overlay) {
                document.body.removeChild(overlay);
                resolve(null);
            }
        });
    });
}

async function analyzeImage(file) {
    if (!file) return null;
    if (window.toastr) toastr.info("Analyzing (DeepGelbooru + WD14)...");
    const imageName = await uploadImageToComfy(file);
    const promptId = await queuePrompt(WORKFLOW_ANALYZE, imageName);
    const entry = await waitForResult(promptId);
    const tags = extractTags(entry);
    if (!tags) throw new Error("Tags not found.");
    return tags;
}

async function handleAnalyze() {
    try {
        const file = await pickFile();
        if (!file) return;
        const tags = await analyzeImage(file);
        const extraPrompt = await promptForText("Edit tags and generate", "Edit tags...", tags);
        if (extraPrompt === null) return;
        await doGenerate(extraPrompt);
    } catch (error) {
        console.error("Ult_generation:", error);
        if (window.toastr) toastr.error(`Analysis error: ${error.message}`);
    }
}

async function handleVariation() {
    try {
        const file = await pickFile();
        if (!file) return;
        const tags = await analyzeImage(file);
        await doGenerate(tags);
    } catch (error) {
        console.error("Ult_generation:", error);
        if (window.toastr) toastr.error(`Variation error: ${error.message}`);
    }
}

async function handleGenerateText() {
    try {
        const extraPrompt = await promptForText("Prompt for generation", "Describe the scene in English...");
        if (!extraPrompt) return;
        await doGenerate(extraPrompt);
    } catch (error) {
        console.error("Ult_generation:", error);
        if (window.toastr) toastr.error(`Generation error: ${error.message}`);
    }
}

async function doGenerate(tags) {
    const characterName = getActiveCharacterName();
    const lora = await findLoraForCharacter(characterName);
    
    let checkpoint = document.getElementById("dd-checkpoint")?.value;
    if (!checkpoint) {
        const checkpoints = await getAvailableCheckpoints();
        if (checkpoints.length > 0) {
            checkpoint = checkpoints[0];
            document.getElementById("dd-checkpoint").value = checkpoint;
        } else {
            throw new Error("Failed to retrieve checkpoint list.");
        }
    }

    if (window.toastr) toastr.info(`Generating${lora ? ` with LoRA "${lora}"` : ' (without LoRA)'}...`);
    const workflow = buildGenerateWorkflow({ tags, checkpoint, lora });
    const promptId = await queuePrompt(workflow, null);
    const entry = await waitForResult(promptId);
    const imageUrl = getGeneratedImageUrl(entry);
    if (!imageUrl) throw new Error("Image not found.");
    await insertImageToChat(imageUrl, tags);
    if (window.toastr) toastr.success(`Done!`);
}

async function populateCheckpointSelect() {
    const select = document.getElementById("dd-checkpoint");
    if (!select) return;
    try {
        const checkpoints = await getAvailableCheckpoints();
        select.replaceChildren();
        if (checkpoints.length === 0) { select.add(new Option("Loading error", "")); return; }
        for (const checkpoint of checkpoints) select.add(new Option(checkpoint, checkpoint));
    } catch (error) {
        console.error("Failed to load checkpoint list:", error);
        select.replaceChildren(new Option("Loading error", ""));
    }
}

function addWandButton() {
    if (document.getElementById("dd-wand-btn")) return;
    const container = document.createElement("div");
    container.id = "dd-wand-container";
    container.style.cssText = "display: inline-flex; align-items: center; position: relative;";
    const btn = document.createElement("button");
    btn.id = "dd-wand-btn";
    btn.className = "menu_button";
    btn.title = "Ult_generation";
    btn.innerHTML = `<i class="fa-solid fa-camera"></i>`;
    btn.style.cssText = "padding: 5px 8px; font-size: 18px; line-height: 1; background: transparent; border: none; color: white; cursor: pointer;";
    const dropdown = document.createElement("div");
    dropdown.id = "dd-wand-dropdown";
    dropdown.style.cssText = `display: none; position: absolute; bottom: 100%; left: 0; background: #1a1a1a; border: 1px solid #333; border-radius: 4px; padding: 5px 0; z-index: 1000; min-width: 220px; box-shadow: 0 4px 6px rgba(0,0,0,0.5);`;
    const item1 = document.createElement("div");
    item1.textContent = "Import tags";
    item1.style.cssText = "padding: 8px 12px; cursor: pointer; color: #ddd; font-size: 14px;";
    item1.onmouseover = () => item1.style.background = "#333";
    item1.onmouseout = () => item1.style.background = "transparent";
    item1.onclick = () => { dropdown.style.display = "none"; handleAnalyze(); };
    const item2 = document.createElement("div");
    item2.textContent = "Variation";
    item2.style.cssText = "padding: 8px 12px; cursor: pointer; color: #ddd; font-size: 14px;";
    item2.onmouseover = () => item2.style.background = "#333";
    item2.onmouseout = () => item2.style.background = "transparent";
    item2.onclick = () => { dropdown.style.display = "none"; handleVariation(); };
    const item3 = document.createElement("div");
    item3.textContent = "Create image (from text)";
    item3.style.cssText = "padding: 8px 12px; cursor: pointer; color: #ddd; font-size: 14px;";
    item3.onmouseover = () => item3.style.background = "#333";
    item3.onmouseout = () => item3.style.background = "transparent";
    item3.onclick = () => { dropdown.style.display = "none"; handleGenerateText(); };
    dropdown.append(item1, item2, item3);
    let isOpen = false;
    btn.onclick = (e) => { e.stopPropagation(); isOpen = !isOpen; dropdown.style.display = isOpen ? "block" : "none"; };
    document.addEventListener("click", () => { if (isOpen) { isOpen = false; dropdown.style.display = "none"; } });
    container.append(btn, dropdown);
    const sendForm = document.getElementById("send_form");
    if (sendForm) {
        const wand = sendForm.querySelector("#chat_wand_button") || sendForm.querySelector(".fa-wand-magic-sparkles");
        if (wand) wand.parentElement.insertBefore(container, wand.parentElement);
        else sendForm.prepend(container);
    }
}

function addExtensionUI() {
    if (document.getElementById("ult-generation")) return;
    const savedUrl = localStorage.getItem(COMFY_URL_KEY) || DEFAULT_COMFY_URL;
    const html = `
        <div id="ult-generation" class="deepdanbooru-settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>Ult_generation</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <label for="dd-comfy-url">ComfyUI Address</label>
                    <div style="display:flex; gap:8px; margin:6px 0 10px;">
                        <input id="dd-comfy-url" type="url" value="${savedUrl.replace(/"/g, "&quot;")}" placeholder="http://127.0.0.1:8188" style="flex:1; min-width:0;">
                        <button id="dd-save-url-btn" class="menu_button" type="button">Save</button>
                    </div>
                    <label for="dd-checkpoint">Checkpoint</label>
                    <select id="dd-checkpoint" style="width:100%; margin:6px 0 10px;"></select>
                </div>
            </div>
        </div>
    `;
    $("#extensions_settings").append(html);
    $("#dd-save-url-btn").on("click", async () => {
        try { 
            setComfyUrl(document.getElementById("dd-comfy-url").value); 
            await populateCheckpointSelect(); 
            if (window.toastr) toastr.success("Saved."); 
        } catch (e) { 
            if (window.toastr) toastr.error(e.message); 
        }
    });
    populateCheckpointSelect();
}

jQuery(() => {
    addExtensionUI();
    setTimeout(addWandButton, 1000);
});