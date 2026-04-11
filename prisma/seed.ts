import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://whymeet:whymeet@localhost:5432/whymeet?schema=public';

const adapter = new PrismaPg({ connectionString: DATABASE_URL });
const prisma = new PrismaClient({ adapter });

// ─── Data pools ─────────────────────────────────────────────────────

const FIRST_NAMES = [
    'Emma',
    'Lucas',
    'Léa',
    'Hugo',
    'Chloé',
    'Nathan',
    'Manon',
    'Thomas',
    'Camille',
    'Raphaël',
    'Inès',
    'Mathis',
    'Sarah',
    'Louis',
    'Jade',
    'Arthur',
    'Louise',
    'Jules',
    'Alice',
    'Gabriel',
    'Lina',
    'Adam',
    'Zoé',
    'Théo',
    'Clara',
    'Maxime',
    'Eva',
    'Noah',
    'Anaïs',
    'Ethan',
    'Margot',
    'Axel',
    'Romane',
    'Valentin',
    'Ambre',
    'Romain',
    'Juliette',
    'Quentin',
    'Océane',
    'Baptiste',
    'Pauline',
    'Antoine',
    'Marine',
    'Pierre',
    'Lucie',
    'Victor',
    'Agathe',
    'Clément',
    'Charlotte',
    'Enzo'
];

const CITIES = [
    'Paris',
    'Lyon',
    'Marseille',
    'Toulouse',
    'Bordeaux',
    'Lille',
    'Nantes',
    'Strasbourg',
    'Montpellier',
    'Nice',
    'Rennes',
    'Grenoble'
];

const BIOS = [
    'Passionné(e) de voyages et de découvertes culinaires 🌍🍕',
    'Développeur(se) le jour, musicien(ne) la nuit 🎸',
    'Toujours partant(e) pour un bon café et une discussion ☕',
    'Addict au sport et à la nature 🏃‍♂️🌿',
    'Amateur(trice) de cinéma indé et de jeux de société 🎬🎲',
    "Créatif(ve) dans l'âme, je dessine et je code ✏️💻",
    'Foodie assumé(e), en quête du meilleur restaurant de la ville 🍜',
    'Amoureux(se) des livres et des longues balades 📚🚶',
    'Entrepreneur(se) dans la tech, toujours à la recherche de nouvelles idées 🚀',
    'Fan de randonnée et de photo de paysages 📷🏔️',
    'DJ amateur le week-end, data analyst la semaine 🎧📊',
    "Yoga le matin, coding l'après-midi, impro le soir 🧘‍♀️",
    'Accro aux podcasts et au café filtre ☕🎧',
    'Globe-trotter en pause, 30 pays au compteur 🗺️',
    "Passionné(e) d'astronomie et de science-fiction 🔭",
    'Cuisto amateur, toujours prêt(e) à partager une recette 👨‍🍳',
    'Skateur(se) et fan de street art 🛹🎨',
    'Mordu(e) de tennis et de escape games 🎾🔓',
    'Cinéphile invétéré(e), 500+ films vus cette année 🎥',
    'Passionné(e) de mode éthique et de DIY ♻️✂️'
];

const SOCIAL_VIBES = ['chill', 'energetic', 'adventurous', 'intellectual', 'creative'] as const;

const INTENTION_KEYS = [
    'dating',
    'serious_relationship',
    'friendship',
    'networking',
    'activity_partner',
    'group_activity',
    'casual_chat'
] as const;

const INTEREST_LABELS = [
    'Photographie',
    'Randonnée',
    'Musique',
    'Cuisine',
    'Cinéma',
    'Voyages',
    'Jeux vidéo',
    'Lecture',
    'Yoga',
    'Escalade',
    'Tennis',
    'Natation',
    'Danse',
    'Peinture',
    'Théâtre',
    'Jardinage',
    'Astronomie',
    'Running',
    'Vélo',
    'Plongée',
    'Street art',
    'Café',
    'Bénévolat',
    'Œnologie',
    'Podcast',
    'Méditation',
    'Skateboard',
    'Surf',
    'Escape game',
    'Karaoké'
];

const SKILL_LABELS = [
    'JavaScript',
    'Python',
    'Design UI',
    'Marketing',
    'Gestion de projet',
    'Data Science',
    'Illustration',
    'Rédaction',
    'Comptabilité',
    'Photo retouche',
    'Montage vidéo',
    'SEO',
    'Community management',
    'DevOps',
    'Machine Learning',
    'Musique (piano)',
    'Guitare',
    'Chant',
    'Couture',
    'Menuiserie'
];

// Alias → canonical tag label
const TAG_ALIASES: Record<string, string> = {
    // Interests aliases
    photo: 'Photographie',
    photos: 'Photographie',
    rando: 'Randonnée',
    randonnées: 'Randonnée',
    trek: 'Randonnée',
    trekking: 'Randonnée',
    musique: 'Musique',
    zik: 'Musique',
    cuisine: 'Cuisine',
    cuisinier: 'Cuisine',
    gastronomie: 'Cuisine',
    films: 'Cinéma',
    cinéma: 'Cinéma',
    cinoche: 'Cinéma',
    film: 'Cinéma',
    voyage: 'Voyages',
    voyager: 'Voyages',
    gaming: 'Jeux vidéo',
    'jeux video': 'Jeux vidéo',
    'jeux-vidéo': 'Jeux vidéo',
    gamer: 'Jeux vidéo',
    bouquins: 'Lecture',
    livres: 'Lecture',
    lire: 'Lecture',
    escalade: 'Escalade',
    grimpe: 'Escalade',
    bloc: 'Escalade',
    nage: 'Natation',
    piscine: 'Natation',
    natation: 'Natation',
    skate: 'Skateboard',
    garden: 'Jardinage',
    jardin: 'Jardinage',
    astro: 'Astronomie',
    étoiles: 'Astronomie',
    courir: 'Running',
    'course à pied': 'Running',
    jogging: 'Running',
    cyclisme: 'Vélo',
    bicyclette: 'Vélo',
    'plongée sous-marine': 'Plongée',
    podcasts: 'Podcast',
    karaoké: 'Karaoké',
    karaoke: 'Karaoké',
    bénévole: 'Bénévolat',
    volontariat: 'Bénévolat',
    vin: 'Œnologie',
    vins: 'Œnologie',
    méditer: 'Méditation',
    mindfulness: 'Méditation',
    // Skills aliases
    js: 'JavaScript',
    node: 'JavaScript',
    nodejs: 'JavaScript',
    typescript: 'JavaScript',
    ts: 'JavaScript',
    py: 'Python',
    'ui design': 'Design UI',
    'ux design': 'Design UI',
    design: 'Design UI',
    webdesign: 'Design UI',
    'gestion projet': 'Gestion de projet',
    'project management': 'Gestion de projet',
    management: 'Gestion de projet',
    data: 'Data Science',
    datascience: 'Data Science',
    ml: 'Machine Learning',
    ia: 'Machine Learning',
    'intelligence artificielle': 'Machine Learning',
    'deep learning': 'Machine Learning',
    'retouche photo': 'Photo retouche',
    photoshop: 'Photo retouche',
    montage: 'Montage vidéo',
    'video editing': 'Montage vidéo',
    piano: 'Musique (piano)',
    couture: 'Couture',
    coudre: 'Couture',
    menuisier: 'Menuiserie',
    bois: 'Menuiserie',
    'community manager': 'Community management',
    cm: 'Community management',
    référencement: 'SEO',
    compta: 'Comptabilité',
    informatique: 'JavaScript',
    ordinateurs: 'JavaScript',
    code: 'JavaScript',
    programmation: 'JavaScript',
    développement: 'JavaScript'
};

const GENDERS = ['male', 'female', 'non_binary', 'other', 'prefer_not_to_say'] as const;
const PERIODS = ['morning', 'noon', 'evening', 'any'] as const;

// ─── Helpers ────────────────────────────────────────────────────────

function pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(Math.random() * arr.length)];
}

function pickN<T>(arr: readonly T[], min: number, max: number): T[] {
    const count = min + Math.floor(Math.random() * (max - min + 1));
    const shuffled = [...arr].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, count);
}

function randomAge(): number {
    return 18 + Math.floor(Math.random() * 22); // 18–39
}

// ─── Main ───────────────────────────────────────────────────────────

async function main() {
    console.log('🌱 Seeding database...');

    const USER_COUNT = 60;

    // 1. Pre-create all tags
    const allLabels = [...new Set([...INTEREST_LABELS, ...SKILL_LABELS])];
    const tagMap = new Map<string, string>();

    for (const label of allLabels) {
        const tag = await prisma.tag.upsert({
            where: { label },
            update: {},
            create: { label }
        });
        tagMap.set(label, tag.id);
    }
    console.log(`  ✅ ${tagMap.size} tags created`);

    // 1b. Create tag aliases
    let aliasCount = 0;
    for (const [alias, canonicalLabel] of Object.entries(TAG_ALIASES)) {
        const tagId = tagMap.get(canonicalLabel);
        if (!tagId) {
            console.warn(`  ⚠️  Alias "${alias}" → "${canonicalLabel}" skipped (tag not found)`);
            continue;
        }
        await prisma.tagAlias.upsert({
            where: { alias },
            update: { tagId },
            create: { alias, tagId }
        });
        aliasCount++;
    }
    console.log(`  ✅ ${aliasCount} tag aliases created`);

    // 2. Create users with profiles and tags
    let created = 0;
    for (let i = 0; i < USER_COUNT; i++) {
        const firstName = FIRST_NAMES[i % FIRST_NAMES.length];
        const suffix = i >= FIRST_NAMES.length ? `${Math.floor(i / FIRST_NAMES.length) + 1}` : '';
        const email = `${firstName.toLowerCase().replace(/[éèê]/g, 'e').replace(/[àâ]/g, 'a').replace(/[ïî]/g, 'i').replace(/[ô]/g, 'o')}${suffix}@seed.whymeet.dev`;

        const city = pick(CITIES);
        const intentions = pickN(INTENTION_KEYS, 1, 3);
        const interests = pickN(INTEREST_LABELS, 2, 6);
        const skills = pickN(SKILL_LABELS, 1, 4);

        // Skip if email already exists
        const exists = await prisma.user.findUnique({ where: { email } });
        if (exists) {
            console.log(`  ⏭️  ${email} already exists, skipping`);
            continue;
        }

        const user = await prisma.user.create({
            data: {
                email,
                name: `${firstName}${suffix}`,
                age: randomAge(),
                avatar: `https://api.dicebear.com/9.x/avataaars/png?seed=${firstName}${suffix}`,
                city,
                gender: pick(GENDERS),
                preferredPeriod: pick(PERIODS),
                verified: Math.random() > 0.3, // 70% verified

                profile: {
                    create: {
                        bio: pick(BIOS),
                        socialVibe: pick(SOCIAL_VIBES),
                        city,
                        country: 'France',
                        region: city,
                        intentions
                    }
                },

                tags: {
                    create: [
                        ...interests.map((label) => ({
                            type: 'interest',
                            tagId: tagMap.get(label)!
                        })),
                        ...skills.map((label) => ({
                            type: 'skill',
                            tagId: tagMap.get(label)!
                        }))
                    ]
                }
            }
        });

        created++;
        if (created % 10 === 0) {
            console.log(`  📦 ${created}/${USER_COUNT} users created...`);
        }
    }

    console.log(`\n🎉 Seed complete: ${created} users created`);
}

main()
    .catch((e) => {
        console.error('❌ Seed failed:', e);
        process.exit(1);
    })
    .finally(() => prisma.$disconnect());
