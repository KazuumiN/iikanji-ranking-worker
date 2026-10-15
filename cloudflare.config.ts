import { bindings, defineConfig, triggers } from "cf/config";

export default defineConfig({
	worker: {
		name: "kuchiguse-ranking",
		compatibilityDate: "2026-10-01",
		entrypoint: "src/index.ts",
		// 個人情報を残さないため、Workers のログ・トレースは取らない
		observability: { enabled: false },
		// *.workers.dev では公開せず、独自ドメインだけで受ける
		workersDev: false,
		previewUrls: false,
		domains: ["kuchiguse.kazuumi.page"],
		// 90日更新のない参加者を毎日削除する（src/index.ts の purgeStale）
		triggers: [triggers.scheduled({ schedule: "17 18 * * *" })],
		env: {
			DB: bindings.d1({
				name: "kuchiguse-ranking",
				id: "955ab533-82ac-47ff-9373-33e1a3e70405",
			}),
		},
	},
});
