<template>
  <UiCardTitle
    subtitle
    :left="$t('hosts')"
    :right="$t('top-#', { n: N_ITEMS })"
  />
  <UsageBar :data="statFetched ? data : undefined" :n-items="N_ITEMS" />
</template>

<script lang="ts" setup>
import UiCardTitle from "@/components/ui/UiCardTitle.vue";
import { type ComputedRef, computed, inject } from "vue";
import UsageBar from "@/components/UsageBar.vue";
import type { Stat } from "@/composables/fetch-stats.composable";
import { formatSize, parseRamUsage } from "@/libs/utils";
import type { HostStats } from "@/libs/xapi-stats";
import { N_ITEMS } from "@/views/pool/PoolDashboardView.vue";

const stats = inject<ComputedRef<Stat<HostStats>[]>>(
  "hostStats",
  computed(() => [])
);

const data = computed(() => {
  const result: {
    id: string;
    label: string;
    value: number;
    badgeLabel: string;
  }[] = [];

  stats.value.forEach((stat) => {
    if (stat.stats === undefined) {
      return;
    }

    const { percentUsed, total, used } = parseRamUsage(stat.stats);
    result.push({
      id: stat.id,
      label: stat.name,
      value: percentUsed,
      badgeLabel: `${formatSize(used)}/${formatSize(total)}`,
    });
  });
  return result;
});

const statFetched: ComputedRef<boolean> = computed(
  () =>
    statFetched.value ||
    (stats.value.length > 0 && stats.value.length === data.value.length)
);
</script>
