#!/usr/bin/env python3
"""Port sermon engine improvements from yah-forge into yah-forge-direct index.html."""
from pathlib import Path
import re

FORGE = Path('/workspace/public/index.html')
DIRECT = Path('/tmp/yah-forge-direct/public/index.html')

forge = FORGE.read_text(encoding='utf-8')
direct = DIRECT.read_text(encoding='utf-8')


def extract_block(src: str, start_marker: str, end_marker: str) -> str:
    i = src.index(start_marker)
    j = src.index(end_marker, i)
    return src[i:j]


def replace_block(dst: str, start_marker: str, end_marker: str, replacement: str) -> str:
    i = dst.index(start_marker)
    j = dst.index(end_marker, i)
    return dst[:i] + replacement + dst[j:]


# --- 1. stripMediaSources (if missing) ---
if 'function stripMediaSources' not in direct:
    block = extract_block(forge, 'function stripMediaSources', '/* ==========================================\n7-PART SERMON')
    direct = direct.replace(
        '/* ==========================================\n7-PART SERMON SERIES ENGINE',
        block + '/* ==========================================\n7-PART SERMON SERIES ENGINE',
        1,
    )

# --- 2. sermon vars + episode/web helpers after sermonPartsCombined ---
helpers = extract_block(
    forge,
    'var sermonUsedWebResearch=false;',
    'function generateSermon(){',
)
direct = replace_block(
    direct,
    'var sermonPartsCombined=\'\';\nfunction generateSermon(){',
    'function generateSermon(){',
    helpers + 'function generateSermon(){',
)

# --- 3. generateSermon init lines ---
direct = direct.replace(
    "currentChapterVerseCount=0;\n// Clear news context",
    "currentChapterVerseCount=0;\nsermonEpisodeModeActive=isSermonEpisodeModeEnabled(currentTopic.title);\nsermonUsedWebResearch=shouldSermonUseWebResearch();\n// Clear news context",
    1,
)

# --- 4. dedupe + generatePart block (replace old helpers through end of generatePart) ---
new_engine = extract_block(
    forge,
    'function hasLeadingMarkdownHeading(text){',
    '/* ==========================================\nHIDDEN THREADS',
)
# Keep stripLeadingPartHeading from direct for seriesComplete compatibility
strip_heading = re.search(
    r'/\*\* Remove the model.*?function stripLeadingPartHeading\(text\)\{.*?\n\}',
    direct,
    re.S,
)
strip_fn = strip_heading.group(0) if strip_heading else ''
new_engine = new_engine.replace(
    'function generatePart(partNum){',
    strip_fn + '\nfunction generatePart(partNum){',
    1,
)
# OpenRouter param helper
openrouter_params = """
function getSermonWebSearchParams(model){
var params={};
if(!shouldSermonUseWebResearch())return params;
if(!forgeSupportsWebBrowse(model))return params;
params.web_search=true;
if(forgeIsOpenAI(model))params.reasoning_effort='low';
return params;
}
"""
new_engine = new_engine.replace(
    'var sermonParams=sermonUsedWebResearch?getWebSearchParams(getSelectedModel()):{};',
    'var sermonParams=getSermonWebSearchParams(getSelectedModel());',
    1,
)
direct = replace_block(
    direct,
    'function extractPartTitle(text,partNum){',
    '/* ==========================================\nHIDDEN THREADS',
    new_engine,
)

# --- 5. seriesComplete ---
series = extract_block(forge, 'function seriesComplete(){', 'function copyAllSermon(){')
# Keep direct's copy plain using mdToPlainText - only replace assembly loop
direct = re.sub(
    r"function seriesComplete\(\)\{.*?// Auto-save to library",
    series.split('// Auto-save to library')[0] + '// Auto-save to library',
    direct,
    count=1,
    flags=re.S,
)

# --- 6. recommendPartCount TV season ---
if 'looksLikeTvSeason(topic.title)' not in direct:
    direct = direct.replace(
        'function recommendPartCount(topic,mode){\nif(!topic)return 3;',
        'function recommendPartCount(topic,mode){\nif(!topic)return 3;\nif(looksLikeTvSeason(topic.title))return 6;',
        1,
    )
direct = direct.replace(
    "if(mwTopic.kind==='tv')return 5;",
    "if(mwTopic.kind==='tv')return 6;",
    1,
)

# --- 7. episode mode functions before media destroy section ---
if 'function buildEpisodeModeBlock' not in direct:
    ep_block = extract_block(forge, 'function looksLikeTvSeason(title){', 'function setMediaParts(n){')
    # Remove media-specific setMediaParts from block
    ep_block = ep_block.split('function setMediaParts')[0]
    direct = direct.replace(
        'function setMediaParts(n){',
        ep_block + 'function setMediaParts(n){',
        1,
    )

# --- 8. buildPartPrompt endings ---
if 'buildEpisodeModeBlock(topic.title' not in direct:
    direct = direct.replace(
        "p+='- Your VERY FIRST output must be the # title line, then '+openingInstruction+'. Nothing before the title. Zero preamble.\\n';\nreturn p;",
        "p+='- Your VERY FIRST output must be the # title line, then '+openingInstruction+'. Nothing before the title. Zero preamble.\\n';\n"
        "if(sermonEpisodeModeActive){\n"
        "p+=buildEpisodeModeBlock(topic.title,partNum,totalParts,wantRoughBez,'sermon');\n"
        "}\n"
        "if(shouldSermonUseWebResearch()){\n"
        "p+=buildWebResearchPromptBlock(topic,chapterSrc);\n"
        "}\n"
        "return p;",
        1,
    )

# ONE PART ONLY prompt (if missing)
if 'ONE PART ONLY -- CRITICAL' not in direct:
    direct = direct.replace(
        "p+='ANTI-DUPLICATION -- NON-NEGOTIABLE: Write each section ONCE only. Do NOT repeat the part title, intro, opening paragraphs, episode breakdowns, or closing lines. If you already covered an episode or scripture point, move forward -- never restart the part from the top. One # Part '+partNum+' header only.\\n';\n}",
        "p+='ANTI-DUPLICATION -- NON-NEGOTIABLE: Write each section ONCE only. Do NOT repeat the part title, intro, opening paragraphs, episode breakdowns, or closing lines. If you already covered an episode or scripture point, move forward -- never restart the part from the top. One # Part '+partNum+' header only.\\n';\n"
        "p+='ONE PART ONLY -- CRITICAL: You are writing ONLY Part '+partNum+' of '+totalParts+'. Do NOT write Part '+(partNum+1)+' or any later part in this response. When you finish your assigned content for THIS part, STOP. The app will request Part '+(partNum+1)+' separately.\\n';\n}",
        1,
    )

# trim previous parts context
direct = direct.replace(
    "p+=(sermonPartsRaw[i]||'[content unavailable]')+'\\n';",
    "p+=trimPartForContext(sermonPartsRaw[i]||'[content unavailable]',partNum<=3?3500:2000)+'\\n';",
    1,
)

# --- 9. UI toggles ---
if 'toggleSermonEpisodeMode' not in direct:
    direct = direct.replace(
        '<label class="toggle-switch" id="toggleBezStoryModeWrap"',
        '<label class="toggle-switch" title="Episode-by-episode TV season breakdown"><input type="checkbox" id="toggleSermonEpisodeMode"><span class="toggle-track"></span><span><i class="fas fa-tv" style="color:#7c9cff;margin-right:3px;font-size:0.7rem;"></i>Episode Mode</span></label>\n'
        '<label class="toggle-switch" title="Use web search for current events and media research"><input type="checkbox" id="toggleWebResearch" checked><span class="toggle-track"></span><span><i class="fas fa-globe" style="color:#38bdb0;margin-right:3px;font-size:0.7rem;"></i>Web Research</span></label>\n'
        '<label class="toggle-switch" id="toggleBezStoryModeWrap"',
        1,
    )

# openModal episode toggle
if 'updateSermonEpisodeToggle' not in direct.split('function openModal')[1][:800]:
    direct = direct.replace(
        "descEl.textContent=currentTopic.desc;\n",
        "descEl.textContent=currentTopic.desc;\nupdateSermonEpisodeToggle(currentTopic?currentTopic.title:'');\n",
        1,
    )

# --- 10. getForgeWordsPerPart if missing ---
if 'function getForgeWordsPerPart' not in direct:
    direct = direct.replace(
        'var selectedPartCount=5;',
        "var selectedPartCount=5;\nfunction getForgeWordsPerPart(partCount){return partCount===1?6000:2000;}\nfunction getForgeTotalWords(partCount){return getForgeWordsPerPart(partCount)*partCount;}\nfunction formatForgeWordEst(partCount){return '~'+getForgeTotalWords(partCount).toLocaleString()+' words';}",
        1,
    )
    direct = direct.replace(
        "document.getElementById('partWordEst').textContent='~'+(n*2000).toLocaleString()+' words';",
        "document.getElementById('partWordEst').textContent=formatForgeWordEst(n);",
        1,
    )

DIRECT.write_text(direct, encoding='utf-8')
print('Patched', DIRECT)
