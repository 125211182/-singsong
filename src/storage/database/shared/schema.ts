import { pgTable, serial, timestamp, varchar, text, jsonb, index } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"

export const healthCheck = pgTable("health_check", {
	id: serial().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
});

// 分享数据表 - 用于存储分享链接和关联数据
export const shareData = pgTable(
	"share_data",
	{
		id: varchar("id", { length: 36 })
			.primaryKey()
			.default(sql`gen_random_uuid()`),
		// 干声音频URL（存储到对象存储后的访问地址）
		refAudioUrl: text("ref_audio_url"),
		// 伴奏音频URL
		accAudioUrl: text("acc_audio_url"),
		// 乐谱图片URL
		scoreImageUrl: text("score_image_url"),
		// 学生评分历史数据（JSON格式）
		studentScores: jsonb("student_scores"),
		// 创建时间
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		index("share_data_created_at_idx").on(table.createdAt),
	]
);
