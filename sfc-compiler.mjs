// import * as SFCCompiler from '@vue/compiler-sfc/dist/compiler-sfc.esm-browser' // production use
import * as SFCCompiler from '@vue/compiler-sfc/dist/compiler-sfc.cjs.js'

const COMP_IDENTIFIER = `__sfc__`

export async function compileFile(filename, code) {

  const compiled = {}
  const id = hashId(filename)
  const { errors, descriptor } = SFCCompiler.parse(code, {
    filename,
    sourceMap: true
  })

  if (errors.length) {
    compiled.errors = errors
    return
  }

  if (
    (descriptor.script && descriptor.script.lang) ||
    (descriptor.scriptSetup && descriptor.scriptSetup.lang) ||
    descriptor.styles.some((s) => s.lang) ||
    (descriptor.template && descriptor.template.lang)
  ) {
    compiled.errors = [
      'lang="x" pre-processors are not supported in the in-browser playground.'
    ]
    return
  }

  const hasScoped = descriptor.styles.some((s) => s.scoped)
  let clientCode = ''
  let ssrCode = ''

  const appendSharedCode = (code) => {
    clientCode += code
    ssrCode += code
  }

  const clientScriptResult = doCompileScript(descriptor, id, false)
  if (!clientScriptResult) {
    return
  }
  const [clientScript, bindings] = clientScriptResult
  clientCode += clientScript

  // script ssr only needs to be performed if using <script setup> where
  // the render fn is inlined.
  if (descriptor.scriptSetup) {
    const ssrScriptResult = doCompileScript(descriptor, id, true)
    if (!ssrScriptResult) {
      return
    }
    ssrCode += ssrScriptResult[0]
  } else {
    // when no <script setup> is used, the script result will be identical.
    ssrCode += clientScript
  }

  // template
  // only need dedicated compilation if not using <script setup>
  if (descriptor.template && !descriptor.scriptSetup) {
    const clientTemplateResult = doCompileTemplate(
      descriptor,
      id,
      bindings,
      false
    )
    if (!clientTemplateResult) {
      return
    }
    clientCode += clientTemplateResult

    const ssrTemplateResult = doCompileTemplate(descriptor, id, bindings, true)
    if (!ssrTemplateResult) {
      return
    }
    ssrCode += ssrTemplateResult
  }

  if (hasScoped) {
    appendSharedCode(
      `\n${COMP_IDENTIFIER}.__scopeId = ${JSON.stringify(`data-v-${id}`)}`
    )
  }

  if (clientCode || ssrCode) {
    appendSharedCode(
      `\n${COMP_IDENTIFIER}.__file = ${JSON.stringify(filename)}` +
        `\nexport default ${COMP_IDENTIFIER}`
    )
    compiled.js = clientCode.trimStart()
    compiled.ssr = ssrCode.trimStart()
  }

  // styles
  let css = ''
  for (const style of descriptor.styles) {
    if (style.module) {
      compiled.errors = [`<style module> is not supported in the playground.`]
      return
    }

    const styleResult = await SFCCompiler.compileStyleAsync({
      source: style.content,
      filename,
      id,
      scoped: style.scoped,
      modules: !!style.module
    })
    if (styleResult.errors.length) {
      if (!styleResult.errors[0].message.includes('pathToFileURL')) {
        compiled.errors = styleResult.errors
      }
    } else {
      css += styleResult.code + '\n'
    }
  }
  if (css) {
    compiled.css = css.trim()
  } else {
    compiled.css = '/* No <style> tags present */'
  }

  // clear errors
  compiled.errors = []
  return compiled
}

function doCompileScript(descriptor, id, ssr) {
  if (descriptor.script || descriptor.scriptSetup) {
    try {
      const compiledScript = SFCCompiler.compileScript(descriptor, {
        id,
        refSugar: true,
        inlineTemplate: true,
        templateOptions: {
          ssr,
          ssrCssVars: descriptor.cssVars
        }
      })
      let code = ''
      if (compiledScript.bindings) {
        code += `\n/* Analyzed bindings: ${JSON.stringify(
          compiledScript.bindings,
          null,
          2
        )} */`
      }
      code +=
        `\n` +
        SFCCompiler.rewriteDefault(compiledScript.content, COMP_IDENTIFIER)
      return [code, compiledScript.bindings]
    } catch (e) {
      return
    }
  } else {
    return [`\nconst ${COMP_IDENTIFIER} = {}`, undefined]
  }
}

function doCompileTemplate(descriptor, id, bindingMetadata, ssr) {
  const templateResult = SFCCompiler.compileTemplate({
    source: descriptor.template?.content,
    filename: descriptor.filename,
    id,
    scoped: descriptor.styles.some(s => s.scoped),
    slotted: descriptor.slotted,
    ssr,
    ssrCssVars: descriptor.cssVars,
    isProd: false,
    compilerOptions: {
      bindingMetadata
    }
  })
  if (templateResult.errors.length) {
    return
  }

  const fnName = ssr ? `ssrRender` : `render`

  return (
    `\n${templateResult.code.replace(
      /\nexport (function|const) (render|ssrRender)/,
      `$1 ${fnName}`
    )}` + `\n${COMP_IDENTIFIER}.${fnName} = ${fnName}`
  )
}

function hashId(filename) {
  let hashHex = filename

  if (typeof window !== 'undefined' && typeof window.btoa === 'function') {
    hashHex = btoa(filename).slice(0, 8)
  } else {
    hashHex = Buffer.from(filename).toString('base64').slice(0, 8)
  }

  return hashHex
}