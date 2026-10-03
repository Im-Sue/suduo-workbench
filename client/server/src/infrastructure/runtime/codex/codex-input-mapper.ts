import type { JsonValue, RuntimeInput } from "@suduo/client-contracts";

export function mapRuntimeInputs(inputs: readonly RuntimeInput[]): JsonValue[] {
  return inputs.map((input) => {
    switch (input.type) {
      case "text":
        return {
          type: "text",
          text: input.text,
          text_elements: [],
        };
      case "local-image":
        return {
          type: "localImage",
          path: input.path,
          ...(input.detail === undefined ? {} : { detail: input.detail }),
        };
      case "image-url":
        return {
          type: "image",
          url: input.url,
          ...(input.detail === undefined ? {} : { detail: input.detail }),
        };
      case "skill":
        return {
          type: "skill",
          name: input.name,
          path: input.path,
        };
    }
  });
}
