import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const MAX_PERMAWEB_FREE_BYTES = 90_000; // Strictly below the 95 KB / 100 KB ArDrive Turbo free limit
const PART_SLICE_CHARS = 55_000;

/**
 * Splits any emitted JS chunk whose minified output still exceeds MAX_PERMAWEB_FREE_BYTES
 * into < 70 KB ES module part files while preserving the exact filename, imports, and export
 * bindings of the parent chunk so every file in dist/ fits inside ArDrive Turbo's free tier (<= 95 KB).
 */
function arweavePermawebChunkLimitPlugin() {
  return {
    name: 'arweave-permaweb-chunk-limit',
    enforce: 'post',
    generateBundle(_options, bundle) {
      for (const [fileName, item] of Object.entries(bundle)) {
        if (item.type !== 'chunk' || typeof item.code !== 'string') continue;
        if (Buffer.byteLength(item.code, 'utf8') <= MAX_PERMAWEB_FREE_BYTES) continue;

        const code = item.code;
        const importRegex =
          /import\s*(?:[A-Za-z0-9_$]+\s*,\s*)?(?:\{[^}]*\}|\*\s*as\s+[A-Za-z0-9_$]+|[A-Za-z0-9_$]+)?\s*from\s*"\.\/[^"]+\.js";?|import\s*"\.\/[^"]+\.js";?/g;

        const importStatements = [];
        const importedVars = [];

        const bodyWithoutImports = code.replace(importRegex, (match) => {
          importStatements.push(match.endsWith(';') ? match : `${match};`);
          const clause = match
            .replace(/from\s*"[^"]+";?$/, '')
            .replace(/^import\s*/, '')
            .trim();
          if (clause && !clause.startsWith('"')) {
            const braceMatch = clause.match(/\{([^}]*)\}/);
            if (braceMatch) {
              for (const part of braceMatch[1].split(',')) {
                const trimmed = part.trim();
                if (!trimmed) continue;
                const aliasParts = trimmed.split(/\s+as\s+/);
                importedVars.push((aliasParts[1] || aliasParts[0]).trim());
              }
            }
            const beforeBrace = clause
              .replace(/\{[^}]*\}/, '')
              .replace(/,/g, '')
              .trim();
            if (beforeBrace) {
              const starMatch = beforeBrace.match(/\*\s*as\s+([A-Za-z0-9_$]+)/);
              if (starMatch) importedVars.push(starMatch[1]);
              else importedVars.push(beforeBrace);
            }
          }
          return '';
        });

        const exportMatch = bodyWithoutImports.match(/export\s*\{([^}]*)\}\s*;?\s*$/);
        const exportsList = exportMatch
          ? exportMatch[1]
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
              .map((spec) => {
                const [local, exported] = spec.split(/\s+as\s+/);
                return {
                  local: local.trim(),
                  exported: (exported || local).trim(),
                };
              })
          : [];

        const rawBody = exportMatch
          ? bodyWithoutImports.slice(0, exportMatch.index)
          : bodyWithoutImports;

        const pureBody = rawBody
          .replace(/\bimport\.meta\b/g, '__mc_import_meta__')
          .replace(/\bimport\s*\((?=[`"])/g, '__mc_dyn_import__(');

        const returnStmt =
          exportsList.length > 0
            ? 'return {' +
              exportsList.map((e) => `${JSON.stringify(e.exported)}:${e.local}`).join(',') +
              '};'
            : '';
        const fullExecutableBody = returnStmt ? `${pureBody}\n${returnStmt}` : pureBody;

        const baseName = fileName.replace(/\.js$/, '');
        const partImports = [];
        const partVars = [];

        for (let offset = 0, idx = 0; offset < fullExecutableBody.length; offset += PART_SLICE_CHARS, idx += 1) {
          const slice = fullExecutableBody.slice(offset, offset + PART_SLICE_CHARS);
          const partFileName = `${baseName}-p${idx}.js`;
          const relativePartPath = `./${partFileName.split('/').pop()}`;
          const partVar = `__mc_p${idx}`;

          this.emitFile({
            type: 'asset',
            fileName: partFileName,
            source: `export default ${JSON.stringify(slice)};\n`,
          });

          partImports.push(`import ${partVar} from "${relativePartPath}";`);
          partVars.push(partVar);
        }

        const uniqueImportedVars = [...new Set(importedVars)];
        const fnParamNames = [...uniqueImportedVars, '__mc_import_meta__', '__mc_dyn_import__'];
        const fnArgExprs = [...uniqueImportedVars, 'import.meta', '(u)=>import(u)'];

        if (exportsList.length > 0) {
          const exportBindings = exportsList
            .map((e, idx) => `const __mc_e${idx}=__mc_mod[${JSON.stringify(e.exported)}];`)
            .join('');
          const exportClause =
            'export{' +
            exportsList.map((e, idx) => `__mc_e${idx} as ${e.exported}`).join(',') +
            '};';

          item.code = [
            ...importStatements,
            ...partImports,
            `const __mc_mod=new Function(${fnParamNames.map((n) => JSON.stringify(n)).join(',')},${partVars.join('+')})(${fnArgExprs.join(',')});`,
            exportBindings,
            exportClause,
          ].join('\n');
        } else {
          item.code = [
            ...importStatements,
            ...partImports,
            `new Function(${fnParamNames.map((n) => JSON.stringify(n)).join(',')},${partVars.join('+')})(${fnArgExprs.join(',')});`,
          ].join('\n');
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [
    tailwindcss(),
    react(),
    arweavePermawebChunkLimitPlugin(),
  ],
  base: './',
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('react-dom')) return 'vendor-react-dom';
          if (id.includes('react-router') || id.includes('@remix-run')) return 'vendor-router';
          if (id.includes('/react/') || id.includes('scheduler')) return 'vendor-react';
          if (id.includes('@tanstack/react-query')) return 'vendor-query';
          if (id.includes('qrcode.react')) return 'vendor-qrcode';
          if (id.includes('@tensorflow-models')) return 'vendor-tf-models';
          if (id.includes('@tensorflow/tfjs-core')) return 'vendor-tf-core';
          if (id.includes('@tensorflow/tfjs-backend-cpu')) return 'vendor-tf-cpu';
          if (id.includes('@tensorflow/tfjs-backend-webgl')) return 'vendor-tf-webgl';
          if (id.includes('@tensorflow/tfjs-converter')) return 'vendor-tf-converter';
          if (id.includes('@tensorflow/tfjs')) return 'vendor-tf';
          if (id.includes('@mediapipe')) return 'vendor-mediapipe';
          if (id.includes('viem/_esm/chains')) return 'vendor-viem-chains';
          if (id.includes('viem/_esm/actions')) return 'vendor-viem-actions';
          if (id.includes('viem/_esm/utils')) return 'vendor-viem-utils';
          if (id.includes('viem')) return 'vendor-viem-core';
          if (id.includes('wagmi') || id.includes('@wagmi')) return 'vendor-wagmi';
          if (id.includes('@noble') || id.includes('@scure')) return 'vendor-crypto';
          if (id.includes('ox/')) return 'vendor-ox';
          if (id.includes('zod')) return 'vendor-zod';
          if (id.includes('styled-components') || id.includes('stylis')) return 'vendor-styled';
          if (id.includes('@heroicons') || id.includes('lucide-react')) return 'vendor-icons';
          return undefined;
        },
      },
    },
  },
  define: { global: 'globalThis' },
});
