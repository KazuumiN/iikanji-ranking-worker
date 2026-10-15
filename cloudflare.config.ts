import { bindings, defineConfig, triggers } from "cf/config";

export default defineConfig({
	worker: {
		name: "iikanji-ranking",
		compatibilityDate: "2026-10-01",
		entrypoint: "src/index.ts",
		// 個人情報を残さないため、Workers のログ・トレースは取らない
		observability: { enabled: false },
		// *.workers.dev では公開せず、独自ドメインだけで受ける
		workersDev: false,
		previewUrls: false,
		domains: ["iikanji.kazuumi.page"],
		// 90日更新のない参加者を毎日削除する（src/index.ts の purgeStale）
		triggers: [triggers.scheduled({ schedule: "17 18 * * *" })],
		env: {
			// 紹介動画を置くバケット（公開はせず、Worker 経由でだけ配信する）
			ASSETS: bindings.r2({ name: "iikanji-assets" }),
			DB: bindings.d1({
				name: "iikanji-ranking",
				id: "334ab305-6c9f-49ac-87ac-78877943d4bc",
			}),
		},
	},
});
