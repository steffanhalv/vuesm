import {
    babelParse,
    MagicString,
    walk,
    walkIdentifiers
    // } from '@vue/compiler-sfc/dist/compiler-sfc.esm-browser'
} from '@vue/compiler-sfc'

import { compileFile } from './sfc-compiler.mjs'

let demo = `<template>
<h1>{{ msg }}</h1>
</template>

<script setup>
const msg = 'Hello Vue SFC2ESM!'
</script>
<style scoped>
h1 {
    color: red
}
</style>
`

async function compileModules(code) {
    const results = await processFile(code)
    console.log(`Successfully compiled to ES Modules`)
    console.log(results)
}

compileModules(demo)

const exportKey = `__export__`
const dynamicImportKey = `__dynamic_import__`
const moduleKey = `__module__`

async function processFile(code) {

    let filename = [...Array(30)].map(() => Math.random().toString(36)[2] || '0').join('')

    let compiled = await compileFile(filename, code)

    const { js, css } = compiled

    const s = new MagicString(js)

    const ast = babelParse(js, {
        sourceFilename: filename,
        sourceType: 'module'
    }).program.body

    const idToImportMap = new Map()
    const declaredConst = new Set()

    function defineExport(name, local = name) {
        s.append(`\n${exportKey}(${moduleKey}, "${name}", () => ${local})`)
    }

    // 0. instantiate module
    s.prepend(
        `window.__modules__ = {}\nwindow.__css__ = ''\n\nconst ${moduleKey} = __modules__[${JSON.stringify(filename)
        }] = { [Symbol.toStringTag]: "Module" }\n\n`
    )

    // 1. check all import statements
    for (const node of ast) {
        if (node.type === 'ImportDeclaration') {}
    }

    // 2. check all export statements and define exports
    for (const node of ast) {
        // named exports
        if (node.type === 'ExportNamedDeclaration') {
            if (node.declaration) {
                if (
                    node.declaration.type === 'FunctionDeclaration' ||
                    node.declaration.type === 'ClassDeclaration'
                ) {
                    defineExport(node.declaration.id?.name)
                } else if (node.declaration.type === 'VariableDeclaration') {
                    for (const decl of node.declaration.declarations) {
                        const names = extractNames(decl.id)
                        for (const name of names) {
                            defineExport(name)
                        }
                    }
                }
                s.remove(node.start, node.declaration.start)
            } else if (node.source) {
                const importId = defineImport(node, node.source.value)
                for (const spec of node.specifiers) {
                    defineExport(
                        (spec.exported).name,
                        `${importId}.${(spec).local.name}`
                    )
                }
                s.remove(node.start, node.end)
            } else {
                // export { foo, bar }
                for (const spec of node.specifiers) {
                    const local = (spec).local.name
                    const binding = idToImportMap.get(local)
                    defineExport((spec.exported).name, binding || local)
                }
                s.remove(node.start, node.end)
            }
        }

        // default export
        if (node.type === 'ExportDefaultDeclaration') {
            s.overwrite(node.start, node.start + 14, `${moduleKey}.default =`)
        }

        // export * from './foo'
        if (node.type === 'ExportAllDeclaration') {
            const importId = defineImport(node, node.source.value)
            s.remove(node.start, node.end)
            s.append(`\nfor (const key in ${importId}) {
        if (key !== 'default') {
        ${exportKey}(${moduleKey}, key, () => ${importId}[key])
        }
    }`)
        }
    }

    // 3. convert references to import bindings
    for (const node of ast) {
        if (node.type === 'ImportDeclaration') continue
        walkIdentifiers(node, (id, parent, parentStack) => {
            const binding = idToImportMap.get(id.name)
            if (!binding) return
            if (isStaticProperty(parent) && parent.shorthand) {
                if (
                    !(parent).inPattern ||
                    isInDestructureAssignment(parent, parentStack)
                ) {
                    s.appendLeft(id.end, `: ${binding}`)
                }
            } else if (
                parent.type === 'ClassDeclaration' &&
                id === parent.superClass
            ) {
                if (!declaredConst.has(id.name)) {
                    declaredConst.add(id.name)
                    // locate the top-most node containing the class declaration
                    const topNode = parentStack[1]
                    s.prependRight(topNode.start, `const ${id.name} = ${binding};\n`)
                }
            } else {
                s.overwrite(id.start, id.end, binding)
            }
        })
    }

    // 4. convert dynamic imports
    ; (walk)(ast, {
        enter(node, parent) {
            if (node.type === 'Import' && parent.type === 'CallExpression') {
                const arg = parent.arguments[0]
                if (arg.type === 'StringLiteral' && arg.value.startsWith('./')) {
                    s.overwrite(node.start, node.start + 6, dynamicImportKey)
                    s.overwrite(
                        arg.start,
                        arg.end,
                        JSON.stringify(arg.value.replace(/^\.\/+/, ''))
                    )
                }
            }
        }
    })

    // append CSS injection code
    if (css) {
        s.append(`\nwindow.__css__ += ${JSON.stringify(css)}`)
    }

    return s.toString()

}

const isStaticProperty = (node) =>
    node.type === 'ObjectProperty' && !node.computed

function extractNames(param) {
    return extractIdentifiers(param).map(id => id.name)
}

function extractIdentifiers(param, nodes = []) {
    switch (param.type) {
        case 'Identifier':
            nodes.push(param)
            break

        case 'MemberExpression':
            let object = param
            while (object.type === 'MemberExpression') {
                object = object.object
            }
            nodes.push(object)
            break

        case 'ObjectPattern':
            param.properties.forEach(prop => {
                if (prop.type === 'RestElement') {
                    extractIdentifiers(prop.argument, nodes)
                } else {
                    extractIdentifiers(prop.value, nodes)
                }
            })
            break

        case 'ArrayPattern':
            param.elements.forEach(element => {
                if (element) extractIdentifiers(element, nodes)
            })
            break

        case 'RestElement':
            extractIdentifiers(param.argument, nodes)
            break

        case 'AssignmentPattern':
            extractIdentifiers(param.left, nodes)
            break
    }

    return nodes
}

function isInDestructureAssignment(parent, parentStack) {
    if (
        parent &&
        (parent.type === 'ObjectProperty' || parent.type === 'ArrayPattern')
    ) {
        let i = parentStack.length
        while (i--) {
            const p = parentStack[i]
            if (p.type === 'AssignmentExpression') {
                return true
            } else if (p.type !== 'ObjectProperty' && !p.type.endsWith('Pattern')) {
                break
            }
        }
    }
    return false
}