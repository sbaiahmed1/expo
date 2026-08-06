import type { ExpoConfig } from 'expo/config';
import {
  type ConfigPlugin,
  withDangerousMod,
  withMainApplication,
  XML,
  CodeGenerator,
  AndroidConfig,
  WarningAggregator,
} from 'expo/config-plugins';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { resolveFontPaths, toValidAndroidResourceName } from './utils';
import type { Font, FontDefinition, FontObject } from './withFonts';

const assetsFontsFir = 'app/src/main/assets/fonts';
const resourcesFontsDir = 'app/src/main/res/font';

// The formats Android's font loader reads. `resolveFontPaths` deliberately keeps `.woff` and `.woff2` for iOS.
const extensionsAndroidCanLoad = ['.ttf', '.otf'];

export const withFontsAndroid: ConfigPlugin<Font[]> = (config, fonts) => {
  const assetFontPaths = fonts.filter((it) => typeof it === 'string');
  config = copyFontsToDir(config, assetFontPaths, assetsFontsFir);

  const xmlFonts = fonts.filter((it) => typeof it === 'object');
  config = addXmlFonts(config, xmlFonts);

  return config;
};

type GroupedFontObject = Record<string, FontDefinition[]>;

export function groupByFamily(array: FontObject[]): GroupedFontObject {
  return array.reduce<GroupedFontObject>((result, item) => {
    const keyValue = item['fontFamily'];
    result[keyValue] ||= [];
    result[keyValue].push(...item.fontDefinitions);
    return result;
  }, {});
}

export function assertAndroidCanLoadFonts(fontsByFamily: GroupedFontObject) {
  for (const [fontFamily, definitions] of Object.entries(fontsByFamily)) {
    for (const definition of definitions) {
      if (extensionsAndroidCanLoad.includes(path.extname(definition.path).toLowerCase())) {
        continue;
      }

      throw new Error(
        `Font family ${JSON.stringify(fontFamily)} declares ${definition.path}, which Android cannot load. ` +
          `Android reads TrueType (.ttf) and OpenType (.otf) files only. To convert a web font such as WOFF or WOFF2, use a utility such as fontTools: https://fonttools.readthedocs.io/`
      );
    }
  }
}

const MIN_FONT_WEIGHT = 1;
const MAX_FONT_WEIGHT = 1000;

export function assertValidWeights(fontsByFamily: GroupedFontObject) {
  for (const [fontFamily, definitions] of Object.entries(fontsByFamily)) {
    for (const definition of definitions) {
      const { weight } = definition;

      if (
        typeof weight === 'number' &&
        Number.isInteger(weight) &&
        weight >= MIN_FONT_WEIGHT &&
        weight <= MAX_FONT_WEIGHT
      ) {
        continue;
      }

      throw new Error(
        `Font family ${JSON.stringify(fontFamily)} declares weight ${JSON.stringify(weight)} for ${definition.path}, which Android cannot read. A weight is a whole number from ${MIN_FONT_WEIGHT} to ${MAX_FONT_WEIGHT}.`
      );
    }
  }
}

/**
 * Throws when two definitions in the same family claim the same weight and style.
 *
 * Android resolves a family by (weight, style), and `FontFamily.Builder.addFont` rejects a second
 * font carrying a pair the family already holds.
 */
export function assertNoConflictingDefinitions(fontsByFamily: GroupedFontObject) {
  for (const [fontFamily, definitions] of Object.entries(fontsByFamily)) {
    const pathByWeightAndStyle = new Map<string, string>();

    for (const definition of definitions) {
      const style = definition.style || 'normal';
      const key = `${definition.weight}/${style}`;
      const alreadyDeclaredBy = pathByWeightAndStyle.get(key);

      if (alreadyDeclaredBy) {
        throw new Error(
          `Font family ${JSON.stringify(fontFamily)} declares more than one font for weight ${definition.weight} and style ${JSON.stringify(style)}: ${alreadyDeclaredBy} and ${definition.path}. ` +
            `Android resolves a font family by weight and style, so it cannot hold two fonts with the same pair — the app would crash on startup while registering the family. ` +
            `Remove the duplicate, or give each definition a weight or style of its own. One variable font file can back several definitions, but weight and style are the only pair Android matches on — it cannot tell two definitions apart by their "axes".`
        );
      }

      pathByWeightAndStyle.set(key, definition.path);
    }
  }
}

// https://learn.microsoft.com/en-us/typography/opentype/spec/dvaraxisreg
const AXIS_TAG_LENGTH = 4;
const AXIS_TAG_PATTERN = /^[A-Za-z][A-Za-z0-9]* *$/;

// Tags are case sensitive: the axes registered with OpenType are lowercase, and the axes a font
// declares for itself are uppercase.
const registeredAxisTags = ['ital', 'opsz', 'slnt', 'wdth', 'wght'];
const FOUNDRY_AXIS_TAG_PATTERN = /^[A-Z][A-Z0-9]* *$/;

type DeclaredAxis = { tag: string; value: unknown; declares: string };

/** Throws when a definition holds `axes` that cannot be read one axis at a time. */
function collectDeclaredAxes(fontsByFamily: GroupedFontObject): DeclaredAxis[] {
  return Object.entries(fontsByFamily).flatMap(([fontFamily, definitions]) =>
    definitions.flatMap((definition) => {
      const axes = definition.axes ?? {};

      if (typeof axes !== 'object' || Array.isArray(axes)) {
        throw new Error(
          `Font family ${JSON.stringify(fontFamily)} declares "axes" for ${definition.path} as ${JSON.stringify(axes)}, which is not an object. ` +
            `"axes" holds one entry per variation axis, such as { "slnt": -10 }.`
        );
      }

      return Object.entries<unknown>(axes).map(([tag, value]) => ({
        tag,
        value,
        declares: `Font family ${JSON.stringify(fontFamily)} declares the variation axis ${JSON.stringify(tag)} for ${definition.path}`,
      }));
    })
  );
}

export function assertValidAxes(fontsByFamily: GroupedFontObject) {
  for (const { tag, value, declares } of collectDeclaredAxes(fontsByFamily)) {
    // On Android 15, `'wght' 900, 'sl t' -10` rendered at weight 900 with no slant: the bad
    // entry is dropped, the rest still applies.
    const consequence = `Android may drop a setting it cannot parse.`;
    const lowercaseTag = tag.toLowerCase();

    if (lowercaseTag === 'wght') {
      throw new Error(
        `${declares}, which the "weight" field already sets. Remove the ${JSON.stringify(tag)} axis and set "weight" to the value you want.`
      );
    }

    // An `app.config.ts` conditional writes `undefined` for the axis it leaves out.
    if (value === undefined) {
      continue;
    }

    if (tag.length !== AXIS_TAG_LENGTH) {
      throw new Error(
        `${declares}, which is not a valid OpenType axis tag. An axis tag is exactly four characters, such as "wght", "wdth" or "slnt". ${consequence} ` +
          `List the axes the font actually declares with a utility such as fontTools: https://fonttools.readthedocs.io/`
      );
    }

    if (!AXIS_TAG_PATTERN.test(tag)) {
      throw new Error(
        `${declares}, which holds characters that no axis tag uses. A tag begins with a letter and holds only letters, digits, or the trailing spaces that pad a shorter tag: the axes registered with OpenType are lowercase, such as "slnt" and "wdth", and the axes a font declares for itself are uppercase, such as "GRAD". ${consequence}`
      );
    }

    if (registeredAxisTags.includes(lowercaseTag) && lowercaseTag !== tag) {
      throw new Error(
        `${declares}, which names no axis because tags are case sensitive. Write it as ${JSON.stringify(lowercaseTag)} — the axes registered with OpenType are lowercase, and only the axes a font declares for itself are uppercase, such as "GRAD". ${consequence}`
      );
    }

    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(
        `${declares} with the value ${JSON.stringify(value)}, which is not a finite number. ` +
          `An axis takes a number inside the range the font declares for it, such as -10 for "slnt". ${consequence}`
      );
    }
  }
}

export function warnAboutUnknownAxisTags(fontsByFamily: GroupedFontObject) {
  for (const { tag, value, declares } of collectDeclaredAxes(fontsByFamily)) {
    const namesAnAxis = registeredAxisTags.includes(tag) || FOUNDRY_AXIS_TAG_PATTERN.test(tag);

    if (value === undefined || namesAnAxis) {
      continue;
    }

    WarningAggregator.addWarningAndroid(
      'expo-font',
      `${declares}, which names no axis: the axes registered with OpenType are lowercase, such as "slnt", and the axes a font declares for itself are uppercase, such as "GRAD". ` +
        `Write the tag in the case the font uses, or Android applies nothing for it. ` +
        `List the axes the font actually declares with a utility such as fontTools: https://fonttools.readthedocs.io/`
    );
  }
}

function formatVariationSettings(definition: FontDefinition) {
  const axes: Record<string, number | undefined> = {
    wght: definition.weight,
    ...definition.axes,
  };

  return Object.entries(axes)
    .filter(([, value]) => value !== undefined)
    .map(([tag, value]) => `'${tag}' ${value}`)
    .join(', ');
}

function addXmlFonts(config: ExpoConfig, xmlFontObjects: FontObject[]) {
  const fontsByFamily = groupByFamily(xmlFontObjects);
  assertAndroidCanLoadFonts(fontsByFamily);
  assertValidWeights(fontsByFamily);
  assertNoConflictingDefinitions(fontsByFamily);
  assertValidAxes(fontsByFamily);
  warnAboutUnknownAxisTags(fontsByFamily);
  const fontPaths = Object.values(fontsByFamily).flatMap((definitions) =>
    definitions.map((it) => it.path)
  );

  config = copyFontsToDir(config, fontPaths, resourcesFontsDir, (filenameWithExt) => {
    const filename = toValidAndroidResourceName(filenameWithExt);
    const ext = path.extname(filenameWithExt);
    return `${filename}${ext}`;
  });

  config = addFontXmlToMainApplication(config, fontsByFamily);

  return withDangerousMod(config, [
    'android',
    async (config) => {
      const fontsDir = path.join(config.modRequest.platformProjectRoot, 'app/src/main/res/font');

      const xmlSpecs = getXmlSpecs(fontsDir, fontsByFamily);

      await Promise.all(xmlSpecs.map(XML.writeXMLAsync));

      return config;
    },
  ]);
}

const resourceNameConflictAvoidancePrefix = 'xml_';

export function getXmlSpecs(fontsDir: string, xmlFontObjects: GroupedFontObject) {
  return Object.entries(xmlFontObjects).map(([fontFamily, fontDefinitions]) => {
    const filePath = path.join(
      fontsDir,
      `${resourceNameConflictAvoidancePrefix + toValidAndroidResourceName(fontFamily)}.xml`
    );
    // each font family has one xml resource file with potentially multiple font definitions
    // the font files (e.g. ttf) at `path` are copied to res/font
    // with their name changed to be a valid resource and referenced in the xml file
    return {
      path: filePath,
      xml: {
        'font-family': {
          // using `app` namespace for better compat:
          // https://developer.android.com/develop/ui/views/text-and-emoji/fonts-in-xml#using-support-lib
          $: {
            'xmlns:app': 'http://schemas.android.com/apk/res-auto',
          },
          font: fontDefinitions.map((definition) => {
            return {
              $: {
                'app:font': `@font/${toValidAndroidResourceName(definition.path)}`,
                'app:fontStyle': definition.style || 'normal',
                'app:fontWeight': String(definition.weight),
                // Instances a variable font at the declared weight and axes, so that one file can
                // back several definitions. Static fonts declare no axes and ignore this.
                'app:fontVariationSettings': formatVariationSettings(definition),
              },
            };
          }),
        },
      },
    };
  });
}

function addFontXmlToMainApplication(config: ExpoConfig, xmlFontObjects: GroupedFontObject) {
  return withMainApplication(config, (config) => {
    const {
      modResults,
      modResults: { language },
    } = config;

    modResults.contents = AndroidConfig.CodeMod.addImports(
      modResults.contents,
      ['com.facebook.react.common.assets.ReactFontManager'],
      language === 'java'
    );

    const fontManagerCalls = generateFontManagerCalls(xmlFontObjects, language).join(os.EOL);

    const withInit = CodeGenerator.mergeContents({
      src: modResults.contents,
      comment: '    //',
      tag: 'xml-fonts-init',
      offset: 1,
      anchor: /super\.onCreate\(\)/,
      newSrc: fontManagerCalls,
    });

    return {
      ...config,
      modResults: {
        ...modResults,
        contents: withInit.contents,
      },
    };
  });
}

export function generateFontManagerCalls(
  xmlFontObjects: GroupedFontObject,
  language: 'java' | 'kt'
) {
  const lineEnding = language === 'java' ? ';' : '';
  const indent = '    ';

  return Object.keys(xmlFontObjects).map(
    (family) =>
      `${indent}ReactFontManager.getInstance().addCustomFont(this, ${JSON.stringify(family)}, R.font.${resourceNameConflictAvoidancePrefix + toValidAndroidResourceName(family)})${lineEnding}`
  );
}

/**
 * A variable font backs one definition per weight, so the same file arrives several times and must
 * only be copied once. Throws when two different files would land on the same one.
 */
export function planFontCopies(
  resolvedFonts: string[],
  fontsDir: string,
  filenameProcessor: (filenameWithExt: string) => string
) {
  const targets = resolvedFonts
    .map((asset) => ({
      asset,
      destination: path.join(fontsDir, filenameProcessor(path.basename(asset))),
    }))
    .filter(({ destination }) => extensionsAndroidCanLoad.some((it) => destination.endsWith(it)));

  const sourceByDestination = new Map<string, string>();

  for (const { asset, destination } of targets) {
    const claimed = sourceByDestination.get(destination);
    if (claimed && claimed !== asset) {
      throw new Error(
        `Font files ${claimed} and ${asset} both become ${path.basename(destination)} in the native project, so only one of them can be embedded. Rename one of them so their file names differ.`
      );
    }
    sourceByDestination.set(destination, asset);
  }

  return sourceByDestination;
}

function copyFontsToDir(
  config: ExpoConfig,
  paths: string[],
  inAppDestination: typeof assetsFontsFir | typeof resourcesFontsDir,
  filenameProcessor = (filenameWithExt: string) => filenameWithExt
) {
  return withDangerousMod(config, [
    'android',
    async (config) => {
      const fontsDir = path.join(config.modRequest.platformProjectRoot, inAppDestination);
      await fs.mkdir(fontsDir, { recursive: true });

      const resolvedFonts = await resolveFontPaths(paths, config.modRequest.projectRoot);
      const copies = planFontCopies(resolvedFonts, fontsDir, filenameProcessor);

      await Promise.all(
        Array.from(copies, ([destination, asset]) => fs.copyFile(asset, destination))
      );
      return config;
    },
  ]);
}
