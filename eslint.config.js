import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

const sourceFiles = ["apps/desktop/src/**/*.{ts,tsx,js,jsx}"];
const productLayerFiles = [
  "apps/desktop/src/app/**/*.{ts,tsx,js,jsx}",
  "apps/desktop/src/features/**/*.{ts,tsx,js,jsx}",
  "apps/desktop/src/platform/**/*.{ts,tsx,js,jsx}",
  "apps/desktop/src/routes/**/*.{ts,tsx,js,jsx}",
  "apps/desktop/src/shared/**/*.{ts,tsx,js,jsx}",
];
const copiedPrimitiveFiles = [
  "apps/desktop/src/components/**/*.{ts,tsx,js,jsx}",
];
const nodeScriptFiles = ["scripts/**/*.mjs", "apps/desktop/scripts/**/*.mjs"];

const appConfigException = "@/app/config/feature-flags";
const routeAppExceptions = new Map([
  ["routes/__root.tsx", new Set(["@/app/providers"])],
  ["routes/space.tsx", new Set(["@/app/shell"])],
]);
const allowedFeatureSubpathExceptions = new Set([
  "@/features/editor/model",
  "@/features/git/api/git-actions",
  "@/features/git/model",
  "@/features/settings/hooks/use-app-version",
  "@/features/space/model",
  "@/features/terminal/lib/is-terminal-keyboard-event",
]);
const allowedComponentProductGlue = new Set([
  "@/features/chat",
  "@/features/editor/hooks/use-resolved-asset-url",
  "@/features/editor/hooks/use-upload-file",
  "@/features/editor/lib/doc-link-utils",
  "@/features/entry",
  "@/features/space/model",
  "@/platform/assets/assets-api",
  "@/platform/filesystem/native-file-picker",
  "@/platform/native/shell",
  "@/platform/upload/media-types",
]);

function srcRelativePath(filename) {
  const normalized = filename.replaceAll("\\", "/");
  const marker = "/apps/desktop/src/";
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex === -1) {
    return null;
  }

  return normalized.slice(markerIndex + marker.length);
}

function layerOf(srcPath) {
  return srcPath?.split("/")[0] ?? null;
}

function sourceValue(node) {
  return typeof node.source?.value === "string" ? node.source.value : null;
}

function featureNameFromPath(srcPath) {
  return srcPath?.match(/^features\/([^/]+)\//)?.[1] ?? null;
}

function featureNameFromSource(source) {
  return source.match(/^@\/features\/([^/]+)(?:\/.*)?$/)?.[1] ?? null;
}

function isFeatureDeepImport(source) {
  return /^@\/features\/[^/]+\/.+/.test(source);
}

function isAllowedRouteAppImport(srcPath, source) {
  return routeAppExceptions.get(srcPath)?.has(source) ?? false;
}

function createImportBoundaryRule() {
  return {
    meta: {
      type: "problem",
      docs: {
        description: "enforce Svode frontend import boundaries",
      },
      schema: [],
      messages: {
        rawTauri:
          "Raw Tauri imports are only allowed in apps/desktop/src/platform. Use a typed platform wrapper instead.",
        sharedUpward:
          "shared must stay generic and cannot import app, features, platform, or stores.",
        platformUpward:
          "platform is the frontend runtime boundary and cannot import app, features, components, stores, or React UI.",
        lowerApp:
          "Lower layers cannot import app code. Only the documented read-only feature-flags config exception is allowed.",
        routeApp:
          "Route files cannot import app code except the documented root/layout wiring exceptions.",
        componentProductGlue:
          "components is copied/registry code. Product/runtime imports require a documented Phase 9 exception.",
        featureWorkspace:
          "features/workspace is not a target owner. Use features/space, features/git, or another current owner.",
        featureDeep:
          "Do not deep-import another feature internals. Import through the feature public API or a documented narrow exception.",
        stores:
          "Top-level stores are no longer a frontend owner. Import state through app or feature owners.",
      },
    },
    create(context) {
      const srcPath = srcRelativePath(context.filename);
      const layer = layerOf(srcPath);
      const currentFeature = featureNameFromPath(srcPath);

      function report(node, messageId) {
        context.report({ node, messageId });
      }

      function checkSource(node, source) {
        if (!srcPath || !layer || !source) {
          return;
        }

        if (source.startsWith("@/features/workspace")) {
          report(node, "featureWorkspace");
          return;
        }

        if (source.startsWith("@/stores/")) {
          report(node, "stores");
          return;
        }

        if (source.startsWith("@tauri-apps/api/") && layer !== "platform") {
          report(node, "rawTauri");
          return;
        }

        if (
          layer === "shared" &&
          /^@\/(app|features|platform|stores)\//.test(source)
        ) {
          report(node, "sharedUpward");
          return;
        }

        if (
          layer === "platform" &&
          (/^@\/(app|features|components|stores)\//.test(source) ||
            source === "react" ||
            source === "react-dom" ||
            source.startsWith("react/") ||
            source.startsWith("react-dom/"))
        ) {
          report(node, "platformUpward");
          return;
        }

        if (
          layer === "routes" &&
          source.startsWith("@/app/") &&
          !isAllowedRouteAppImport(srcPath, source)
        ) {
          report(node, "routeApp");
          return;
        }

        if (
          ["features", "platform", "shared", "components"].includes(layer) &&
          source.startsWith("@/app/") &&
          source !== appConfigException
        ) {
          report(node, "lowerApp");
          return;
        }

        if (layer === "components") {
          if (
            /^@\/(features|platform)\//.test(source) &&
            !allowedComponentProductGlue.has(source)
          ) {
            report(node, "componentProductGlue");
          }
          return;
        }

        if (isFeatureDeepImport(source)) {
          const importedFeature = featureNameFromSource(source);
          if (
            importedFeature &&
            importedFeature !== currentFeature &&
            !allowedFeatureSubpathExceptions.has(source)
          ) {
            report(node, "featureDeep");
          }
        }
      }

      return {
        ImportDeclaration(node) {
          checkSource(node, sourceValue(node));
        },
        ExportNamedDeclaration(node) {
          checkSource(node, sourceValue(node));
        },
        ExportAllDeclaration(node) {
          checkSource(node, sourceValue(node));
        },
        ImportExpression(node) {
          const source =
            typeof node.source?.value === "string" ? node.source.value : null;
          checkSource(node, source);
        },
      };
    },
  };
}

const svodePlugin = {
  rules: {
    "import-boundaries": createImportBoundaryRule(),
  },
};

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: sourceFiles,
    plugins: {
      svode: svodePlugin,
    },
  },
  {
    files: nodeScriptFiles,
    languageOptions: {
      globals: {
        Buffer: "readonly",
        console: "readonly",
        process: "readonly",
      },
    },
  },
  {
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    files: productLayerFiles,
    rules: {
      "svode/import-boundaries": "error",
    },
  },
  {
    files: copiedPrimitiveFiles,
    rules: {
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "no-useless-assignment": "off",
      "react-hooks/preserve-manual-memoization": "off",
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/static-components": "off",
      "svode/import-boundaries": "error",
    },
  },
  {
    ignores: [
      "**/dist/**",
      "**/target/**",
      "**/node_modules/**",
      "**/*.gen.*",
      "**/paraglide/**",
    ],
  },
);
