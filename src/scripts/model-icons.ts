import openaiLogo from "@lobehub/icons-static-svg/icons/openai.svg?url";
import claudeLogo from "@lobehub/icons-static-svg/icons/claude-color.svg?url";
import geminiLogo from "@lobehub/icons-static-svg/icons/gemini-color.svg?url";
import grokLogo from "@lobehub/icons-static-svg/icons/grok.svg?url";
import deepSeekLogo from "@lobehub/icons-static-svg/icons/deepseek-color.svg?url";
import mistralLogo from "@lobehub/icons-static-svg/icons/mistral-color.svg?url";
import metaLogo from "@lobehub/icons-static-svg/icons/meta-color.svg?url";
import microsoftLogo from "@lobehub/icons-static-svg/icons/microsoft-color.svg?url";
import qwenLogo from "@lobehub/icons-static-svg/icons/qwen-color.svg?url";
import nvidiaLogo from "@lobehub/icons-static-svg/icons/nvidia-color.svg?url";
import cohereLogo from "@lobehub/icons-static-svg/icons/cohere-color.svg?url";
import perplexityLogo from "@lobehub/icons-static-svg/icons/perplexity-color.svg?url";
import minimaxLogo from "@lobehub/icons-static-svg/icons/minimax-color.svg?url";
import kimiLogo from "@lobehub/icons-static-svg/icons/kimi-color.svg?url";
import xiaomiLogo from "@lobehub/icons-static-svg/icons/xiaomimimo.svg?url";
import zaiLogo from "@lobehub/icons-static-svg/icons/zai.svg?url";
import nousLogo from "@lobehub/icons-static-svg/icons/nousresearch.svg?url";
import arceeLogo from "@lobehub/icons-static-svg/icons/arcee-color.svg?url";
import liquidLogo from "@lobehub/icons-static-svg/icons/liquid.svg?url";
import ai21Logo from "@lobehub/icons-static-svg/icons/ai21-brand-color.svg?url";
import ai2Logo from "@lobehub/icons-static-svg/icons/ai2-color.svg?url";
import novaLogo from "@lobehub/icons-static-svg/icons/nova-color.svg?url";
import bytedanceLogo from "@lobehub/icons-static-svg/icons/bytedance-color.svg?url";
import stepfunLogo from "@lobehub/icons-static-svg/icons/stepfun-color.svg?url";
import inceptionLogo from "@lobehub/icons-static-svg/icons/inception.svg?url";
import inflectionLogo from "@lobehub/icons-static-svg/icons/inflection.svg?url";
import tencentLogo from "@lobehub/icons-static-svg/icons/tencent-color.svg?url";
import baiduLogo from "@lobehub/icons-static-svg/icons/baidu-color.svg?url";
import huggingFaceLogo from "@lobehub/icons-static-svg/icons/huggingface-color.svg?url";

export interface ModelBrand {
  name: string;
  logo: string;
  monochrome?: boolean;
}

const brand = (name: string, logo: string, monochrome = false): ModelBrand => ({
  name,
  logo,
  monochrome,
});

const MODEL_BRANDS: Record<string, ModelBrand> = {
  openai: brand("OpenAI", openaiLogo, true),
  anthropic: brand("Anthropic", claudeLogo),
  google: brand("Google", geminiLogo),
  "x-ai": brand("xAI", grokLogo, true),
  xai: brand("xAI", grokLogo, true),
  deepseek: brand("DeepSeek", deepSeekLogo),
  mistralai: brand("Mistral AI", mistralLogo),
  mistral: brand("Mistral AI", mistralLogo),
  "meta-llama": brand("Meta", metaLogo),
  meta: brand("Meta", metaLogo),
  microsoft: brand("Microsoft", microsoftLogo),
  qwen: brand("Qwen", qwenLogo),
  alibaba: brand("Alibaba", qwenLogo),
  nvidia: brand("NVIDIA", nvidiaLogo),
  cohere: brand("Cohere", cohereLogo),
  perplexity: brand("Perplexity", perplexityLogo),
  minimax: brand("MiniMax", minimaxLogo),
  minimaxai: brand("MiniMax", minimaxLogo),
  moonshotai: brand("Moonshot AI", kimiLogo),
  moonshot: brand("Moonshot AI", kimiLogo),
  kimi: brand("Moonshot AI", kimiLogo),
  xiaomi: brand("Xiaomi", xiaomiLogo, true),
  "z-ai": brand("Z.ai", zaiLogo, true),
  zai: brand("Z.ai", zaiLogo, true),
  nousresearch: brand("Nous Research", nousLogo, true),
  nous: brand("Nous Research", nousLogo, true),
  "arcee-ai": brand("Arcee AI", arceeLogo),
  arcee: brand("Arcee AI", arceeLogo),
  liquid: brand("Liquid AI", liquidLogo, true),
  ai21: brand("AI21 Labs", ai21Logo),
  allenai: brand("Allen Institute for AI", ai2Logo),
  ai2: brand("Allen Institute for AI", ai2Logo),
  amazon: brand("Amazon", novaLogo),
  "amazon-nova": brand("Amazon", novaLogo),
  bytedance: brand("ByteDance", bytedanceLogo),
  stepfun: brand("StepFun", stepfunLogo),
  inception: brand("Inception", inceptionLogo, true),
  inflection: brand("Inflection", inflectionLogo, true),
  tencent: brand("Tencent", tencentLogo),
  baidu: brand("Baidu", baiduLogo),
  huggingfaceh4: brand("Hugging Face", huggingFaceLogo),
};

export function modelBrandFor(modelId: string): ModelBrand | null {
  // OpenRouter prefixes moving aliases such as "Latest" with `~`
  // (`~anthropic/claude-opus-latest`). It is routing metadata, not
  // part of the model author's slug.
  const normalized = modelId.toLowerCase().replace(/^~+/, "");
  const author = normalized.split("/", 1)[0];
  const exact = author ? MODEL_BRANDS[author] : null;
  if (exact) return exact;

  const families: Array<[RegExp, string]> = [
    [/(^|[/_-])(gpt|chatgpt|o[1-9])([/_.-]|$)|openai/, "openai"],
    [/claude|anthropic/, "anthropic"],
    [/gemini|gemma|google/, "google"],
    [/grok|x-ai/, "x-ai"],
    [/deepseek/, "deepseek"],
    [/mistral|mixtral|codestral/, "mistralai"],
    [/(^|[/_.-])llama([/_.-]|$)|meta-llama/, "meta-llama"],
    [/(^|[/_.-])phi([/_.-]|$)|microsoft/, "microsoft"],
    [/qwen|qwq|alibaba/, "qwen"],
    [/command-r|cohere/, "cohere"],
    [/sonar|perplexity/, "perplexity"],
    [/minimax/, "minimax"],
    [/kimi|moonshot/, "moonshotai"],
    [/(^|[/_.-])mimo([/_.-]|$)|xiaomi/, "xiaomi"],
    [/(^|[/_.-])glm([/_.-]|$)|z-ai/, "z-ai"],
    [/hermes|nous/, "nousresearch"],
    [/arcee/, "arcee-ai"],
    [/liquid/, "liquid"],
    [/jamba|ai21/, "ai21"],
    [/olmo|allenai/, "allenai"],
    [/(^|[/_.-])nova([/_.-]|$)|amazon/, "amazon"],
    [/bytedance/, "bytedance"],
    [/stepfun/, "stepfun"],
    [/inception|mercury/, "inception"],
    [/inflection/, "inflection"],
    [/tencent|hunyuan/, "tencent"],
    [/baidu|ernie/, "baidu"],
  ];
  const match = families.find(([pattern]) => pattern.test(normalized));
  return match ? MODEL_BRANDS[match[1]] : null;
}
