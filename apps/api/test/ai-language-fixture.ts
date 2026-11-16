import type { AiLanguage } from '@feedink/shared';
import { englishAiParagraph } from './ai-fixture.js';

// Authored synthetic prose only. These samples are not a representative language-quality benchmark.
export const supportedAiLanguageSamples = [
  { language: 'en', title: 'The results of the research', paragraph: englishAiParagraph },
  { language: 'zh-CN', title: '研究团队公布科学实验的重要发现', paragraph: '研究人员仔细检查了这次科学实验收集的所有证据，并向公众解释了这些观察结果如何支持他们的主要结论，同时指出仍然存在的不确定性以及未来需要进一步调查的重要问题。' },
  { language: 'ja', title: '研究チームによる科学実験の重要な結果', paragraph: '研究者たちは今回の科学実験で集められた証拠を丁寧に調べ、観察された結果がどのように結論を裏付けているのかを説明するとともに、まだ残っている不確実性と今後の調査で確認すべき重要な課題について報告しました。' },
  { language: 'ko', title: '마을 도서관의 새로운 운영 시간 안내', paragraph: '마을 도서관은 주민들이 퇴근 후에도 편리하게 책을 빌리고 조용한 공간에서 공부할 수 있도록 다음 달부터 평일 운영 시간을 연장하고 어린이를 위한 새로운 독서 프로그램을 준비한다고 발표했습니다.' },
  { language: 'fr', title: 'Les résultats de la recherche', paragraph: 'Les chercheurs ont soigneusement examiné les preuves historiques et expliqué les conclusions de cette expérience scientifique avec toutes les limites importantes.' },
  { language: 'de', title: 'Die Ergebnisse der Untersuchung', paragraph: 'Die Wissenschaftler haben die historischen Belege sorgfältig untersucht und erklärt, wie die wissenschaftlichen Beobachtungen ihre Schlussfolgerungen unterstützen, während sie auf die verbleibenden Unsicherheiten des Versuchs hinweisen.' },
  { language: 'es', title: 'Los resultados de la investigación', paragraph: 'Los investigadores examinaron cuidadosamente las pruebas históricas y explicaron cómo las observaciones científicas respaldan la conclusión, reconociendo al mismo tiempo la incertidumbre que todavía existe sobre el experimento.' },
] satisfies { language: AiLanguage; title: string; paragraph: string }[];

export const unsupportedAiLanguageSamples = [
  { name: 'Italian', paragraph: 'I ricercatori hanno esaminato attentamente le prove storiche e spiegato come le osservazioni scientifiche sostengano la conclusione, riconoscendo anche le incertezze che rimangono riguardo alle condizioni dell’esperimento.' },
  { name: 'Portuguese', paragraph: 'Os pesquisadores examinaram cuidadosamente as evidências históricas e explicaram como as observações científicas sustentam a conclusão, reconhecendo também as incertezas que ainda existem sobre as condições do experimento.' },
  { name: 'Dutch', paragraph: 'De onderzoekers hebben het historische bewijsmateriaal zorgvuldig onderzocht en uitgelegd hoe de wetenschappelijke waarnemingen hun conclusie ondersteunen, terwijl zij ook de resterende onzekerheden over het experiment erkennen.' },
  { name: 'Russian', paragraph: 'Исследователи внимательно изучили исторические свидетельства и объяснили, как научные наблюдения подтверждают выводы, одновременно отметив сохраняющуюся неопределённость относительно условий проведённого эксперимента.' },
  { name: 'Arabic', paragraph: 'درس الباحثون الأدلة التاريخية بعناية وشرحوا كيف تدعم الملاحظات العلمية الاستنتاجات مع الاعتراف بوجود جوانب غير مؤكدة تحتاج إلى المزيد من البحث والتحليل قبل نشر النتائج النهائية للتجربة.' },
];

export const englishAiBoundedSentence = `${englishAiParagraph.slice(0, -1)} and carefully recorded the results before publishing their findings.`;
export const englishAiLongSentence = 'The public library is preparing a new programme that will help local families discover books about science and history while giving children a quiet place to read after school, and the librarians have asked teachers to suggest stories that encourage discussion about the natural world and the lives of people in other countries, while volunteers are arranging comfortable chairs near the windows and checking that every visitor can find the information they need before the building opens for the first reading session on Saturday morning.';
export const shortEnglishAiRemainder = 'The researchers explained the findings';
export const shortForeignAiFragments = [
  { name: 'French', text: 'Les résultats de la recherche' },
  { name: 'German', text: 'Die Ergebnisse der Untersuchung' },
  { name: 'Spanish', text: 'Los resultados de la investigación' },
  { name: 'Italian', text: 'Buongiorno a tutti' },
  { name: 'Chinese', text: '这是中文段落，不得静默跳过。' },
];
