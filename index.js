//import * as vueCompiler from '@vue/compiler-dom/dist/compiler-dom.cjs.js'
import * as vueCompiler from '@vue/compiler-sfc/dist/compiler-sfc.cjs.js'

let demo = `<template>
<h1>{{ msg }}</h1>
</template>

<script setup>
const msg = 'Hello Vue SFC2ESM!'
</script>

<style scoped>
h1 {
    color: red;
}
</style>
`

console.log(vueCompiler.parse(demo))