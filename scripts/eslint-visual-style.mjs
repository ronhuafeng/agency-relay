const visualProperties = new Set([
  "background",
  "backgroundColor",
  "border",
  "borderColor",
  "borderRadius",
  "boxShadow",
  "color",
  "fontSize",
  "outline",
]);

const rule = {
  meta: {
    type: "problem",
    docs: { description: "Keep visual decisions in tokens instead of authored style properties." },
    schema: [],
    messages: {
      visual: "Use a token-backed class instead of the visual style property {{name}}.",
    },
  },
  create(context) {
    return {
      JSXAttribute(node) {
        if (node.name.type !== "JSXIdentifier" || node.name.name !== "style") return;
        const expression = node.value?.type === "JSXExpressionContainer" ? node.value.expression : null;
        if (!expression || expression.type !== "ObjectExpression") return;
        for (const property of expression.properties) {
          if (property.type !== "Property") continue;
          const name = property.key.type === "Identifier" ? property.key.name : property.key.type === "Literal" ? property.key.value : null;
          if (typeof name === "string" && visualProperties.has(name)) {
            context.report({ node: property, messageId: "visual", data: { name } });
          }
        }
      },
    };
  },
};

export default {
  rules: { "visual-style": rule },
};
