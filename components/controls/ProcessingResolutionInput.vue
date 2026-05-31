<template>
  <div class="space-y-1">
    <label class="text-xs text-gray-500 dark:text-gray-400">{{ t('controlPanel.processingResolutionLabel') }}</label>
    <input
      v-model="inputValue"
      type="text"
      inputmode="decimal"
      @input="handleInput"
      class="w-full border rounded px-2 py-2 text-sm outline-none bg-white dark:bg-gray-800 border-gray-300 dark:border-gray-600 text-gray-900 dark:text-white focus:ring-2 focus:ring-[#FF6600] focus:border-[#FF6600]"
    />
    <p class="text-[10px] text-gray-500 dark:text-gray-400">{{ t('controlPanel.processingResolutionHint') }}</p>
  </div>
</template>

<script setup>
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';

const { t } = useI18n({ useScope: 'global' });

const props = defineProps({
  // Processing resolution in metres per pixel.
  modelValue: { type: [Number, String], default: 1 },
});
const emit = defineEmits(['update:modelValue']);

// Allow only positive decimals (free-typed; up to 10 decimal places).
const PATTERN = /^\d*\.?\d*$/;
const inputValue = ref('1');

const isValid = (value) => {
  const trimmed = String(value ?? '').trim();
  if (!trimmed || trimmed === '.') return false;
  if (!PATTERN.test(trimmed)) return false;
  if ((trimmed.split('.')[1] || '').length > 10) return false;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed > 0;
};

const handleInput = () => {
  if (!isValid(inputValue.value)) return;
  emit('update:modelValue', Number(inputValue.value.trim()));
};

// Keep the field in sync with the source of truth (e.g. config load).
watch(() => props.modelValue, (newValue) => {
  const parsed = Number(newValue);
  inputValue.value = Number.isFinite(parsed) && parsed > 0 ? String(parsed) : '1';
}, { immediate: true });
</script>
