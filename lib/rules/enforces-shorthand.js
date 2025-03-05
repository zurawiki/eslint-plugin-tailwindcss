/**
 * @fileoverview Avoid using multiple Tailwind CSS classnames when not required (e.g. "mx-3 my-3" could be replaced by "m-3")
 * Optimized for performance.
 */
'use strict';

const docsUrl = require('../util/docsUrl');
const defaultGroups = require('../config/groups').groups;
const customConfig = require('../util/customConfig');
const astUtil = require('../util/ast');
const groupUtil = require('../util/groupMethods');
const getOption = require('../util/settings');
const parserUtil = require('../util/parser');

// Precompute target groups once per rule instance
const targetProperties = {
  Layout: ['Overflow', 'Overscroll Behavior', 'Top / Right / Bottom / Left'],
  'Flexbox & Grid': ['Gap'],
  Spacing: ['Padding', 'Margin'],
  Sizing: ['Width', 'Height'],
  Borders: ['Border Radius', 'Border Width', 'Border Color'],
  Tables: ['Border Spacing'],
  Transforms: ['Scale'],
  Typography: ['Text Overflow', 'Whitespace'],
};

const getTargetGroups = () => {
  const cloned = defaultGroups.map(g => ({ ...g, members: [...g.members] }));
  const filtered = cloned.filter(g => targetProperties.hasOwnProperty(g.type));
  filtered.forEach(g => {
    g.members = g.members.filter(sub => targetProperties[g.type].includes(sub.type));
  });
  return filtered;
};

const targetGroupsStatic = getTargetGroups();

const placeContentOptions = ['center', 'start', 'end', 'between', 'around', 'evenly', 'baseline', 'stretch'];
const placeItemsOptions = ['start', 'end', 'center', 'stretch'];
const placeSelfOptions = ['auto', 'start', 'end', 'center', 'stretch'];
const complexEquivalences = [
  {
    needles: ['overflow-hidden', 'text-ellipsis', 'whitespace-nowrap'],
    shorthand: 'truncate',
    mode: 'exact',
  },
  {
    needles: ['w-', 'h-'],
    shorthand: 'size-',
    mode: 'value',
  },
  ...placeContentOptions.map(opt => ({
    needles: [`content-${opt}`, `justify-${opt}`],
    shorthand: `place-content-${opt}`,
    mode: 'exact',
  })),
  ...placeItemsOptions.map(opt => ({
    needles: [`items-${opt}`, `justify-items-${opt}`],
    shorthand: `place-items-${opt}`,
    mode: 'exact',
  })),
  ...placeSelfOptions.map(opt => ({
    needles: [`self-${opt}`, `justify-self-${opt}`],
    shorthand: `place-self-${opt}`,
    mode: 'exact',
  })),
];

const SHORTHAND_CANDIDATE_CLASSNAMES_DETECTED_MSG =
  "Classnames '{{classnames}}' could be replaced by the '{{shorthand}}' shorthand!";

module.exports = {
  meta: {
    docs: {
      description: 'Enforces the usage of shorthand Tailwind CSS classnames',
      category: 'Best Practices',
      recommended: true,
      url: docsUrl('enforces-shorthand'),
    },
    messages: {
      shorthandCandidateDetected: SHORTHAND_CANDIDATE_CLASSNAMES_DETECTED_MSG,
    },
    fixable: 'code',
    schema: [
      {
        type: 'object',
        properties: {
          callees: {
            type: 'array',
            items: { type: 'string', minLength: 0 },
            uniqueItems: true,
          },
          ignoredKeys: {
            type: 'array',
            items: { type: 'string', minLength: 0 },
            uniqueItems: true,
          },
          config: {
            type: ['string', 'object'],
          },
          tags: {
            type: 'array',
            items: { type: 'string', minLength: 0 },
            uniqueItems: true,
          },
        },
      },
    ],
  },

  create(context) {
    const callees = getOption(context, 'callees');
    const skipClassAttribute = getOption(context, 'skipClassAttribute');
    const tags = getOption(context, 'tags');
    const twConfig = getOption(context, 'config');
    const classRegex = getOption(context, 'classRegex');

    const mergedConfig = customConfig.resolve(twConfig);
    // Cache mergedConfig.theme.size to avoid repeated lookups.
    const themeSize = mergedConfig.theme && mergedConfig.theme.size;
    const targetGroups = targetGroupsStatic;

    const getBodyByShorthand = (targetGroups, parentType, shorthand) => {
      const mainGroup = targetGroups.find(g => g.members.some(m => m.type === parentType));
      if (!mainGroup) return '';
      const typeGroup = mainGroup.members.find(m => m.type === parentType);
      if (!typeGroup) return '';
      const type = typeGroup.members.find(m => m.shorthand === shorthand);
      return type ? type.body : '';
    };

    const parseForShorthandCandidates = (node, arg = null) => {
      let originalClassNamesValue = null;
      let start = null;
      let end = null;
      let prefix = '';
      let suffix = '';
      const troubles = [];
      if (arg === null) {
        originalClassNamesValue = astUtil.extractValueFromNode(node);
        const range = astUtil.extractRangeFromNode(node);
        if (node.type === 'TextAttribute') {
          start = range[0];
          end = range[1];
        } else {
          start = range[0] + 1;
          end = range[1] - 1;
        }
      } else {
        switch (arg.type) {
          case 'Identifier':
            return;
          case 'TemplateLiteral':
            arg.expressions.forEach(exp => parseForShorthandCandidates(node, exp));
            arg.quasis.forEach(quasi => parseForShorthandCandidates(node, quasi));
            return;
          case 'ConditionalExpression':
            parseForShorthandCandidates(node, arg.consequent);
            parseForShorthandCandidates(node, arg.alternate);
            return;
          case 'LogicalExpression':
            parseForShorthandCandidates(node, arg.right);
            return;
          case 'ArrayExpression':
            arg.elements.forEach(el => parseForShorthandCandidates(node, el));
            return;
          case 'ObjectExpression': {
            const isUsedByClassNamesPlugin = node.callee && node.callee.name === 'classnames';
            const isVue = node.key && node.key.type === 'VDirectiveKey';
            arg.properties.forEach(prop => {
              const propVal = isUsedByClassNamesPlugin || isVue ? prop.key : prop.value;
              parseForShorthandCandidates(node, propVal);
            });
            return;
          }
          case 'Property':
            parseForShorthandCandidates(node, arg.key);
            return;
          case 'Literal':
            originalClassNamesValue = arg.value;
            start = arg.range[0] + 1;
            end = arg.range[1] - 1;
            break;
          case 'TemplateElement': {
            originalClassNamesValue = arg.value.raw;
            if (originalClassNamesValue === '') return;
            start = arg.range[0];
            end = arg.range[1];
            const txt = context.getSourceCode().getText(arg);
            prefix = astUtil.getTemplateElementPrefix(txt, originalClassNamesValue);
            suffix = astUtil.getTemplateElementSuffix(txt, originalClassNamesValue);
            originalClassNamesValue = astUtil.getTemplateElementBody(txt, prefix, suffix);
            break;
          }
          default:
            return;
        }
      }

      const { classNames, whitespaces, headSpace, tailSpace } =
        astUtil.extractClassnamesFromValue(originalClassNamesValue);
      if (classNames.length <= 1) return;

      const parsed = classNames.map((className, index) =>
        groupUtil.parseClassname(className, targetGroups, mergedConfig, index)
      );
      let validated = [];
      let remaining = [...parsed];

      for (const { needles: inputSet, shorthand: outputClassname, mode } of complexEquivalences) {
        if (remaining.length < inputSet.length) continue;
        const parsedElementsInInputSet = remaining.filter(remainingClass => {
          if (mode === 'exact') {
            return inputSet.some(inputClass => remainingClass.name.includes(inputClass));
          }
          if (mode === 'value') {
            const bodyMatch = inputSet.some(
              inputClassPattern => `${mergedConfig.prefix}${inputClassPattern}` === remainingClass.body
            );
            if (!themeSize) return false;
            const sizeKeys = Object.keys(themeSize);
            const isSize = ['w-', 'h-'].includes(remainingClass.body);
            const isValidSize = sizeKeys.includes(remainingClass.value);
            const wValue = mergedConfig.theme.width[remainingClass.value];
            const hValue = mergedConfig.theme.height[remainingClass.value];
            const sizeValue = themeSize[remainingClass.value];
            const fullMatch = wValue === hValue && wValue === sizeValue;
            return bodyMatch && !(isSize && !isValidSize && !fullMatch);
          }
          return false;
        });
        const variantGroups = new Map();
        for (const o of parsedElementsInInputSet) {
          const key = o.variants + (o.important ? '!' : '') + (mode === 'value' ? o.value : '');
          if (!variantGroups.has(key)) variantGroups.set(key, []);
          variantGroups.get(key).push(o);
        }
        for (const classes of variantGroups.values()) {
          if (classes.length < inputSet.length) continue;
          if (mode === 'value' && new Set(classes.map(p => p.value)).size !== 1) continue;
          const candidate = classes[0];
          const variants = candidate.variants;
          const important = candidate.important ? '!' : '';
          const classValue = mode === 'value' ? candidate.value : '';
          const patchedClassname = `${variants}${important}${mergedConfig.prefix}${outputClassname}${classValue}`;
          troubles.push([classes.map(c => c.name), patchedClassname]);
          const validatedClassname = groupUtil.parseClassname(patchedClassname, targetGroups, mergedConfig, candidate.index);
          validated.push(validatedClassname);
          const candidateSet = new Set(classes);
          remaining = remaining.filter(p => !candidateSet.has(p));
        }
      }

      const parentGroups = new Map();
      for (const cls of remaining) {
        const key = cls.parentType;
        if (!parentGroups.has(key)) parentGroups.set(key, []);
        parentGroups.get(key).push(cls);
      }
      for (const [parentType, sameType] of parentGroups.entries()) {
        if (!parentType) {
          validated.push(...sameType);
          continue;
        }
        const variantGroups = new Map();
        for (const cls of sameType) {
          const key = cls.variants + (cls.important ? '!' : '') + cls.value;
          if (!variantGroups.has(key)) variantGroups.set(key, []);
          variantGroups.get(key).push(cls);
        }
        for (const classes of variantGroups.values()) {
          if (classes.length === 1) {
            validated.push(classes[0]);
          } else if (classes.length) {
            const supportCorners = parentType === 'Border Radius';
            const hasTL = supportCorners && classes.some(c => ['tl', 't', 'all'].includes(c.shorthand));
            const hasTR = supportCorners && classes.some(c => ['tr', 't', 'all'].includes(c.shorthand));
            const hasBR = supportCorners && classes.some(c => ['br', 'b', 'all'].includes(c.shorthand));
            const hasBL = supportCorners && classes.some(c => ['bl', 'b', 'all'].includes(c.shorthand));
            const hasT = classes.some(c => c.shorthand === 't') || (hasTL && hasTR);
            const hasR = classes.some(c => c.shorthand === 'r') || (hasTR && hasBR);
            const hasB = classes.some(c => c.shorthand === 'b') || (hasBL && hasBR);
            const hasL = classes.some(c => c.shorthand === 'l') || (hasTL && hasBL);
            const hasX = classes.some(c => c.shorthand === 'x') || (hasL && hasR);
            const hasY = classes.some(c => c.shorthand === 'y') || (hasT && hasB);
            const hasAllProp = classes.some(c => c.shorthand === 'all');
            const hasAllPropNoCorner = hasY && hasX;
            const hasAllPropWithCorners = (hasL && hasR) || (hasT && hasB);
            const hasAllEquivalent = !supportCorners ? hasAllPropNoCorner : hasAllPropWithCorners;
            const hasAll = hasAllProp || hasAllEquivalent;
            const sample = classes[0];
            const important = sample.important ? '!' : '';
            const isNegative = ('' + sample.value).startsWith('-');
            const minus = isNegative ? '-' : '';
            const absoluteVal = isNegative ? ('' + sample.value).slice(1) : sample.value;

            if (hasAll) {
              const all = getBodyByShorthand(targetGroups, parentType, 'all');
              const val = absoluteVal.length ? '-' + absoluteVal : '';
              const patchedName = `${sample.variants}${important}${minus}${mergedConfig.prefix}${all}${val}`;
              troubles.push([classes.map(c => c.name), patchedName]);
              validated.push({ ...sample, name: patchedName, shorthand: 'all' });
            } else if (hasY || hasX) {
              const xOrY = hasX ? 'x' : 'y';
              const xOrYType = getBodyByShorthand(targetGroups, parentType, xOrY);
              const patchedName = `${sample.variants}${important}${minus}${mergedConfig.prefix}${xOrYType}${absoluteVal.length ? '-' + absoluteVal : ''}`;
              const toBeReplaced = classes
                .filter(c => (hasX ? ['l', 'r'] : ['t', 'b']).includes(c.shorthand))
                .map(c => c.name);
              troubles.push([toBeReplaced, patchedName]);
              let replaced = false;
              classes.forEach(ref => {
                if ((hasX && ['l', 'r'].includes(ref.shorthand)) || (hasY && ['t', 'b'].includes(ref.shorthand))) {
                  if (!replaced) {
                    replaced = true;
                    validated.push({ ...ref, name: patchedName, shorthand: xOrY });
                  } else {
                    validated.push(ref);
                  }
                } else {
                  validated.push(ref);
                }
              });
            } else if (
              supportCorners &&
              classes.some(c => ['t', 'r', 'b', 'l'].includes(c.shorthand))
            ) {
              const side = classes.find(c => c.shorthand === 't')
                ? 't'
                : classes.find(c => c.shorthand === 'r')
                ? 'r'
                : classes.find(c => c.shorthand === 'b')
                ? 'b'
                : 'l';
              const sideBody = getBodyByShorthand(targetGroups, parentType, side);
              const val = absoluteVal.length ? '-' + absoluteVal : '';
              const patchedName = `${sample.variants}${important}${minus}${mergedConfig.prefix}${sideBody}${val}`;
              const toBeReplaced = classes
                .filter(c => {
                  const candidates = side === 't' ? ['tl', 'tr'] : side === 'r' ? ['tr', 'br'] : side === 'b' ? ['bl', 'br'] : ['tl', 'bl'];
                  return candidates.includes(c.shorthand);
                })
                .map(c => c.name);
              troubles.push([toBeReplaced, patchedName]);
              let replaced = false;
              classes.forEach(ref => {
                if (toBeReplaced.includes(ref.name)) {
                  if (!replaced) {
                    replaced = true;
                    validated.push({ ...ref, name: patchedName, shorthand: side });
                  } else {
                    validated.push(ref);
                  }
                } else {
                  validated.push(ref);
                }
              });
            } else {
              validated.push(...classes);
            }
          }
        }
      }

      validated.sort((a, b) => a.index - b.index);
      const union = validated.map(val => val.leading + val.name + val.trailing);
      const head = headSpace ? whitespaces[0] : '';
      const tail = tailSpace ? whitespaces[whitespaces.length - 1] : '';
      let validatedClassNamesValue = union.length === 1 ? head + union[0] + tail : '';
      if (!validatedClassNamesValue) {
        for (let i = 0; i < union.length; i++) {
          const isLast = i === union.length - 1;
          validatedClassNamesValue += headSpace ? `${whitespaces[i] ?? ''}${union[i]}` : isLast ? union[i] : union[i] + (whitespaces[i] ?? '');
          if (tailSpace && isLast) validatedClassNamesValue += tail;
        }
      }
      if (originalClassNamesValue !== validatedClassNamesValue) {
        const fixedValue = prefix + validatedClassNamesValue + suffix;
        troubles.forEach(issue => {
          context.report({
            node,
            messageId: 'shorthandCandidateDetected',
            data: {
              classnames: issue[0].join(', '),
              shorthand: issue[1],
            },
            fix(fixer) {
              return fixer.replaceTextRange([start, end], fixedValue);
            },
          });
        });
      }
    };

    const attributeVisitor = node => {
      if (skipClassAttribute || !astUtil.isClassAttribute(node, classRegex)) return;
      if (astUtil.isLiteralAttributeValue(node)) {
        parseForShorthandCandidates(node);
      } else if (node.value && node.value.type === 'JSXExpressionContainer') {
        parseForShorthandCandidates(node, node.value.expression);
      }
    };

    const callExpressionVisitor = node => {
      const calleeStr = astUtil.calleeToString(node.callee);
      if (!callees.includes(calleeStr)) return;
      node.arguments.forEach(arg => parseForShorthandCandidates(node, arg));
    };

    const scriptVisitor = {
      JSXAttribute: attributeVisitor,
      TextAttribute: attributeVisitor,
      CallExpression: callExpressionVisitor,
      TaggedTemplateExpression(node) {
        const tagName = node.tag.name || node.tag.object?.name || node.tag.callee?.name;
        if (!tags.includes(tagName)) return;
        parseForShorthandCandidates(node, node.quasi);
      },
    };

    const templateVisitor = {
      CallExpression: callExpressionVisitor,
      VAttribute(node) {
        if (!astUtil.isValidVueAttribute(node, classRegex)) return;
        if (astUtil.isVLiteralValue(node)) {
          parseForShorthandCandidates(node);
        } else if (astUtil.isArrayExpression(node)) {
          node.value.expression.elements.forEach(arg => parseForShorthandCandidates(node, arg));
        } else if (astUtil.isObjectExpression(node)) {
          node.value.expression.properties.forEach(prop => parseForShorthandCandidates(node, prop));
        }
      },
    };

    return parserUtil.defineTemplateBodyVisitor(context, templateVisitor, scriptVisitor);
  },
};
