import { isSuccess, type NpeResponseObserver } from "./provider-transport";
import { XAI_FILE_ID, bindFileId } from "./file-ownership";
import { recordImageMediaUsage } from "./media-store";
import { type ExecutionPlan } from "../plans/execution-plans";
import { type ProxyResponseBodyOutcome } from "../proxy/adapter";

const MAX_IMAGE_METADATA_DEPTH = 64;

const MAX_IMAGE_OUTPUT_FILE_IDS = 64;

export function createImagePlanObserver(
  env: Env,
  userId: string,
  plan: ExecutionPlan,
  now: () => Date
): NpeResponseObserver {
  const metadata = createImageMetadataStreamObserver();
  let observation: ImageMetadataObservation | undefined;
  let bindingFailed = false;
  return {
    onChunk(chunk) {
      metadata.push(chunk);
    },
    beforeClose: plan.protocol !== "xai/api" ? async (outcome) => {
      observation = metadata.finish();
      if (outcome.kind === "completed" && isSuccess(outcome.upstreamStatus)) {
        bindingFailed = await bindImageOutputs(env, userId, plan, now, observation);
        if (bindingFailed) throw new Error("image output ownership could not be committed");
      }
    } : undefined,
    async onDone(outcome) {
      await finalizeImageObservation(
        env,
        userId,
        plan,
        now,
        outcome,
        observation ?? metadata.finish(), bindingFailed
      );
    }
  };
}

interface ImageMetadataObservation {
  fileIds: string[];
  outputs: number | null;
  costTicks: number | null;
}

function createImageMetadataStreamObserver(): {
  push(chunk: Uint8Array): void;
  finish(): ImageMetadataObservation;
} {
  const decoder = new TextDecoder();
  const metadata = createImageMetadataJsonObserver();
  const syntax = createStreamingJsonSyntaxValidator();
  let finished = false;
  return {
    push(chunk) {
      if (!finished) {
        const text = decoder.decode(chunk, { stream: true });
        syntax.push(text);
        metadata.push(text);
      }
    },
    finish() {
      if (!finished) {
        finished = true;
        const tail = decoder.decode();
        syntax.push(tail);
        metadata.push(tail);
      }
      const observation = metadata.finish();
      return syntax.finish()
        ? observation
        : { fileIds: [], outputs: null, costTicks: null };
    }
  };
}

type JsonSyntaxFrame = {
  kind: "object";
  state: "first_key_or_end" | "key" | "colon" | "value" | "comma_or_end";
} | {
  kind: "array";
  state: "first_value_or_end" | "value" | "comma_or_end";
};

function createStreamingJsonSyntaxValidator(): {
  push(text: string): void;
  finish(): boolean;
} {
  const frames: JsonSyntaxFrame[] = [];
  let rootState: "value" | "complete" = "value";
  let token: "string" | "number" | "literal" | null = null;
  let escaped = false;
  let unicodeDigits = 0;
  let numberState: "minus" | "zero" | "int" | "dot" | "frac" | "exp" | "exp_sign" | "exp_digits" | null = null;
  let literalRemainder = "";
  let invalid = false;

  const current = () => frames.at(-1);
  const beginValue = () => {
    const frame = current();
    if (!frame) {
      if (rootState !== "value") {
        invalid = true;
        return;
      }
      rootState = "complete";
      return;
    }
    if (frame.kind === "object") {
      if (frame.state !== "value") {
        invalid = true;
        return;
      }
      frame.state = "comma_or_end";
      return;
    }
    if (frame.state !== "first_value_or_end" && frame.state !== "value") {
      invalid = true;
      return;
    }
    frame.state = "comma_or_end";
  };
  const startNumber = (character: string) => {
    token = "number";
    numberState = character === "-" ? "minus" : character === "0" ? "zero" : "int";
  };
  const numberConsumes = (character: string): boolean => {
    const digit = character >= "0" && character <= "9";
    if (digit) {
      if (numberState === "minus") {
        numberState = character === "0" ? "zero" : "int";
        return true;
      }
      if (numberState === "int" || numberState === "frac" || numberState === "exp_digits") {
        return true;
      }
      if (numberState === "dot") {
        numberState = "frac";
        return true;
      }
      if (numberState === "exp" || numberState === "exp_sign") {
        numberState = "exp_digits";
        return true;
      }
      return false;
    }
    if (character === "." && (numberState === "zero" || numberState === "int")) {
      numberState = "dot";
      return true;
    }
    if ((character === "e" || character === "E")
      && (numberState === "zero" || numberState === "int" || numberState === "frac")) {
      numberState = "exp";
      return true;
    }
    if ((character === "+" || character === "-") && numberState === "exp") {
      numberState = "exp_sign";
      return true;
    }
    return false;
  };
  const numberComplete = () => numberState === "zero"
    || numberState === "int"
    || numberState === "frac"
    || numberState === "exp_digits";

  const processStructural = (character: string) => {
    if (/\s/.test(character)) {
      return;
    }
    const frame = current();
    if (!frame) {
      if (rootState === "complete") {
        invalid = true;
        return;
      }
      beginValueCharacter(character);
      return;
    }
    if (frame.kind === "object") {
      if (frame.state === "first_key_or_end" || frame.state === "key") {
        if (frame.state === "first_key_or_end" && character === "}") {
          frames.pop();
        } else if (character === '"') {
          frame.state = "colon";
          token = "string";
          escaped = false;
          unicodeDigits = 0;
        } else {
          invalid = true;
        }
        return;
      }
      if (frame.state === "colon") {
        if (character === ":") {
          frame.state = "value";
        } else {
          invalid = true;
        }
        return;
      }
      if (frame.state === "value") {
        beginValueCharacter(character);
        return;
      }
      if (character === ",") {
        frame.state = "key";
      } else if (character === "}") {
        frames.pop();
      } else {
        invalid = true;
      }
      return;
    }
    if (frame.state === "first_value_or_end" || frame.state === "value") {
      if (frame.state === "first_value_or_end" && character === "]") {
        frames.pop();
      } else {
        beginValueCharacter(character);
      }
      return;
    }
    if (character === ",") {
      frame.state = "value";
    } else if (character === "]") {
      frames.pop();
    } else {
      invalid = true;
    }
  };

  function beginValueCharacter(character: string): void {
    beginValue();
    if (invalid) {
      return;
    }
    if (character === "{") {
      frames.push({ kind: "object", state: "first_key_or_end" });
    } else if (character === "[") {
      frames.push({ kind: "array", state: "first_value_or_end" });
    } else if (character === '"') {
      token = "string";
      escaped = false;
      unicodeDigits = 0;
    } else if (character === "t") {
      token = "literal";
      literalRemainder = "rue";
    } else if (character === "f") {
      token = "literal";
      literalRemainder = "alse";
    } else if (character === "n") {
      token = "literal";
      literalRemainder = "ull";
    } else if (character === "-" || (character >= "0" && character <= "9")) {
      startNumber(character);
    } else {
      invalid = true;
    }
    if (frames.length > MAX_IMAGE_METADATA_DEPTH) {
      invalid = true;
    }
  }

  return {
    push(text) {
      for (const character of text) {
        if (invalid) {
          continue;
        }
        if (token === "string") {
          if (unicodeDigits > 0) {
            if (!/[0-9a-fA-F]/.test(character)) {
              invalid = true;
            } else {
              unicodeDigits -= 1;
            }
          } else if (escaped) {
            escaped = false;
            if (character === "u") {
              unicodeDigits = 4;
            } else if (!'"\\/bfnrt'.includes(character)) {
              invalid = true;
            }
          } else if (character === "\\") {
            escaped = true;
          } else if (character === '"') {
            token = null;
          } else if (character.charCodeAt(0) < 0x20) {
            invalid = true;
          }
          continue;
        }
        if (token === "literal") {
          if (character !== literalRemainder[0]) {
            invalid = true;
          } else {
            literalRemainder = literalRemainder.slice(1);
            if (literalRemainder.length === 0) {
              token = null;
            }
          }
          continue;
        }
        if (token === "number") {
          if (numberConsumes(character)) {
            continue;
          }
          if (!numberComplete()) {
            invalid = true;
            continue;
          }
          token = null;
          numberState = null;
        }
        processStructural(character);
      }
    },
    finish() {
      if (token === "number" && numberComplete()) {
        token = null;
        numberState = null;
      }
      return !invalid && token === null && frames.length === 0 && rootState === "complete";
    }
  };
}

type ImageJsonFrame = {
  kind: "object";
  role: "root" | "usage" | "data_item" | "file_output" | "other";
  key: string | null;
  pendingKey: string | null;
  expectsKey: boolean;
} | {
  kind: "array";
  role: "data" | "other";
};

function createImageMetadataJsonObserver(): {
  push(text: string): void;
  finish(): ImageMetadataObservation;
} {
  const frames: ImageJsonFrame[] = [];
  const fileIds: string[] = [];
  let fileIdLimitExceeded = false;
  let rootSeen = false;
  let dataSeen = false;
  let dataClosed = false;
  let outputs = 0;
  let costTicks: number | null = null;
  let costSeen = false;
  let costInvalid = false;
  let costState: "awaiting" | "digits" | "trailing" | null = null;
  let costBuffer = "";
  let inString = false;
  let escaped = false;
  let stringHasEscape = false;
  let stringOverflow = false;
  let stringBuffer = "";
  let invalid = false;

  const current = () => frames.at(-1);
  const startCost = () => {
    if (costSeen) {
      costInvalid = true;
      return;
    }
    costSeen = true;
    costState = "awaiting";
    costBuffer = "";
  };
  const finishCostDigits = () => {
    const candidate = Number(costBuffer);
    if (!Number.isSafeInteger(candidate) || candidate < 0) {
      costInvalid = true;
      costTicks = null;
      return;
    }
    costTicks = candidate;
  };
  const observeString = () => {
    const frame = current();
    const value = stringHasEscape || stringOverflow ? null : stringBuffer;
    if (!frame) {
      return;
    }
    if (frame.kind === "array") {
      if (frame.role === "data") {
        outputs += 1;
      }
      return;
    }
    if (frame.expectsKey) {
      frame.pendingKey = value;
      return;
    }
    if (
      frame.role === "file_output"
      && frame.key === "file_id"
      && value !== null
      && XAI_FILE_ID.test(value)
      && !fileIds.includes(value)
    ) {
      if (fileIds.length < MAX_IMAGE_OUTPUT_FILE_IDS) {
        fileIds.push(value);
      } else {
        fileIdLimitExceeded = true;
      }
    }
  };

  return {
    push(text) {
      for (const character of text) {
        if (invalid) {
          continue;
        }
        if (inString) {
          if (escaped) {
            escaped = false;
            continue;
          }
          if (character === "\\") {
            escaped = true;
            stringHasEscape = true;
            continue;
          }
          if (character === '"') {
            inString = false;
            observeString();
            continue;
          }
          if (stringBuffer.length < 256) {
            stringBuffer += character;
          } else {
            stringOverflow = true;
          }
          continue;
        }

        if (costState === "awaiting") {
          if (/\s/.test(character)) {
            continue;
          }
          if (character >= "0" && character <= "9") {
            costState = "digits";
            costBuffer = character;
            continue;
          }
          costInvalid = true;
          costState = null;
        } else if (costState === "digits") {
          if (character >= "0" && character <= "9") {
            if (costBuffer.length < 20) {
              costBuffer += character;
            } else {
              costInvalid = true;
            }
            continue;
          }
          finishCostDigits();
          if (/\s/.test(character)) {
            costState = "trailing";
            continue;
          }
          costState = null;
          if (character !== "," && character !== "}") {
            costInvalid = true;
          }
        } else if (costState === "trailing") {
          if (/\s/.test(character)) {
            continue;
          }
          costState = null;
          if (character !== "," && character !== "}") {
            costInvalid = true;
          }
        }

        if (character === '"') {
          const frame = current();
          if (costSeen && costState === null && frame?.kind === "object"
            && frame.role === "usage" && frame.key === "cost_in_usd_ticks") {
            costInvalid = true;
          }
          inString = true;
          escaped = false;
          stringHasEscape = false;
          stringOverflow = false;
          stringBuffer = "";
          continue;
        }
        if (character === "{") {
          const parent = current();
          let role: Extract<ImageJsonFrame, { kind: "object" }>["role"] = "other";
          if (!parent && !rootSeen) {
            rootSeen = true;
            role = "root";
          } else if (parent?.kind === "object" && parent.role === "root" && parent.key === "usage") {
            role = "usage";
          } else if (parent?.kind === "array" && parent.role === "data") {
            outputs += 1;
            role = "data_item";
          } else if (parent?.kind === "object" && parent.role === "data_item" && parent.key === "file_output") {
            role = "file_output";
          }
          frames.push({ kind: "object", role, key: null, pendingKey: null, expectsKey: true });
        } else if (character === "[") {
          const parent = current();
          const isData = parent?.kind === "object" && parent.role === "root" && parent.key === "data";
          if (isData) {
            dataSeen = true;
          } else if (parent?.kind === "array" && parent.role === "data") {
            outputs += 1;
          }
          frames.push({ kind: "array", role: isData ? "data" : "other" });
        } else if (character === ":") {
          const frame = current();
          if (frame?.kind === "object" && frame.expectsKey) {
            frame.key = frame.pendingKey;
            frame.pendingKey = null;
            frame.expectsKey = false;
            if (frame.role === "usage" && frame.key === "cost_in_usd_ticks") {
              startCost();
            }
          }
        } else if (character === ",") {
          const frame = current();
          if (frame?.kind === "object") {
            frame.key = null;
            frame.pendingKey = null;
            frame.expectsKey = true;
          }
        } else if (character === "}") {
          if (current()?.kind !== "object") {
            invalid = true;
          } else {
            frames.pop();
          }
        } else if (character === "]") {
          const frame = current();
          if (frame?.kind !== "array") {
            invalid = true;
          } else {
            if (frame.role === "data") {
              dataClosed = true;
            }
            frames.pop();
          }
        }
        if (frames.length > MAX_IMAGE_METADATA_DEPTH) {
          invalid = true;
        }
      }
    },
    finish() {
      if (costState === "digits") {
        finishCostDigits();
      } else if (costState === "awaiting") {
        costInvalid = true;
      }
      const complete = !invalid && !fileIdLimitExceeded && !inString && frames.length === 0 && rootSeen;
      return {
        fileIds: complete ? fileIds : [],
        outputs: complete && dataSeen && dataClosed ? outputs : null,
        costTicks: complete && costSeen && !costInvalid ? costTicks : null
      };
    }
  };
}

async function bindImageOutputs(
  env: Env,
  userId: string,
  plan: ExecutionPlan,
  now: () => Date,
  observation: ImageMetadataObservation
): Promise<boolean> {
  let bindingFailed = false;
  for (const fileId of observation.fileIds) {
    try {
      const bound = await bindFileId(
        env, fileId, userId, "image_output", null, now()
      );
      if (!bound) {
        throw new Error("owner collision");
      }
    } catch {
      bindingFailed = true;
      console.error(JSON.stringify({
        event: "xai_file_output_binding_failed",
        plan_id: plan.id,
        source: "image_output"
      }));
    }
  }
  return bindingFailed;
}

async function finalizeImageObservation(
  env: Env, userId: string, plan: ExecutionPlan, now: () => Date,
  outcome: ProxyResponseBodyOutcome, observation: ImageMetadataObservation,
  bindingFailed: boolean
): Promise<void> {
  const ok = outcome.kind === "completed" && isSuccess(outcome.upstreamStatus);
  try {
    await recordImageMediaUsage(env, {
      user_id: userId,
      route_profile_id: plan.id,
      capability: imageCapability(plan),
      status: ok && !bindingFailed ? "ok" : "error",
      outputs: ok ? observation.outputs : null,
      provider_cost_usd_ticks: ok ? observation.costTicks : null
    }, now());
  } catch {
    console.error(JSON.stringify({ event: "image_media_accounting_failed", plan_id: plan.id }));
  }
}

export function isImagePlan(plan: ExecutionPlan): boolean {
  return plan.usageObserver === "image";
}

export function imageCapability(plan: ExecutionPlan): "image_generation" | "image_edit" {
  return plan.id.endsWith("images_edits") ? "image_edit" : "image_generation";
}
