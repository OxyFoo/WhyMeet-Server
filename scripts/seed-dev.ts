import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { INTENTIONS, INTENTION_CATEGORIES } from '@oxyfoo/whymeet-types';
import { seedReferenceData } from '../prisma/seed';
import { deleteImagePair, storeProfilePhotoFromBuffer } from '../src/services/photoStorageService';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://whymeet:whymeet@localhost:5432/whymeet?schema=public';

const adapter = new PrismaPg({ connectionString: DATABASE_URL });
const prisma = new PrismaClient({ adapter });

// Keep this aligned with the discovery completion rules.
const MIN_DISCOVERY_TAGS = 5;
const MAX_DISCOVERY_TAGS = 10;
const SEED_PROFILE_PHOTO_COUNT = 1;
const SEED_AVATAR_POOL_SIZE = 48;
const SEED_AVATAR_SOURCE_SIZE = 512;
const SEED_STORAGE_CONCURRENCY = 6;

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

const SOCIAL_VIBES = ['reserved', 'calm', 'balanced', 'outgoing', 'very_social'] as const;

const PARENT_INTENTIONS_BY_CATEGORY = new Map(
    INTENTION_CATEGORIES.map((category) => [
        category.key,
        INTENTIONS.filter((context) => context.parentKey === category.key)
    ])
);
const CHILD_INTENTIONS_BY_PARENT = new Map(
    INTENTIONS.map((context) => [context.key, INTENTIONS.filter((child) => child.parentKey === context.key)])
);

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
    'Piano',
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

const CITY_COORDS: Record<string, { lat: number; lng: number }> = {
    Paris: { lat: 48.8566, lng: 2.3522 },
    Lyon: { lat: 45.764, lng: 4.8357 },
    Marseille: { lat: 43.2965, lng: 5.3698 },
    Toulouse: { lat: 43.6047, lng: 1.4442 },
    Bordeaux: { lat: 44.8378, lng: -0.5792 },
    Lille: { lat: 50.6292, lng: 3.0573 },
    Nantes: { lat: 47.2184, lng: -1.5536 },
    Strasbourg: { lat: 48.5734, lng: 7.7521 },
    Montpellier: { lat: 43.6108, lng: 3.8767 },
    Nice: { lat: 43.7102, lng: 7.262 },
    Rennes: { lat: 48.1173, lng: -1.6778 },
    Grenoble: { lat: 45.1885, lng: 5.7245 }
};

const SPOKEN_LANGUAGES = ['fr', 'en', 'es', 'de', 'it', 'pt', 'ar', 'zh', 'ja', 'ko'] as const;

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

function pickProfileIntentionKeys(): string[] {
    const category = pick(INTENTION_CATEGORIES);
    const parentIntentions = PARENT_INTENTIONS_BY_CATEGORY.get(category.key) ?? [];
    const parentIntention = pick(parentIntentions.length > 0 ? parentIntentions : INTENTIONS);
    const childIntentions = CHILD_INTENTIONS_BY_PARENT.get(parentIntention.key) ?? [];
    const keys = new Set<string>([parentIntention.key]);

    if (childIntentions.length > 0 && Math.random() > 0.45) {
        keys.add(pick(childIntentions).key);
    }

    if (Math.random() > 0.7) {
        const otherCategories = INTENTION_CATEGORIES.filter((candidate) => candidate.key !== category.key);
        const otherCategory = pick(otherCategories.length > 0 ? otherCategories : INTENTION_CATEGORIES);
        const otherParentIntentions = PARENT_INTENTIONS_BY_CATEGORY.get(otherCategory.key) ?? [];
        if (otherParentIntentions.length > 0) keys.add(pick(otherParentIntentions).key);
    }

    return [...keys];
}

function randomBirthDate(): Date {
    const age = 18 + Math.floor(Math.random() * 22); // 18–39
    const today = new Date();
    const year = today.getFullYear() - age;
    const month = Math.floor(Math.random() * 12);
    const day = 1 + Math.floor(Math.random() * 28);
    return new Date(year, month, day);
}

async function mapWithConcurrency<T, R>(
    items: T[],
    limit: number,
    mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
    const results = new Array<R>(items.length);
    let nextIndex = 0;

    async function worker(): Promise<void> {
        while (nextIndex < items.length) {
            const currentIndex = nextIndex;
            nextIndex += 1;
            results[currentIndex] = await mapper(items[currentIndex] as T, currentIndex);
        }
    }

    const workerCount = Math.min(limit, items.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return results;
}

function buildSeedAvatarFallback(index: number): Buffer {
    const backgroundHue = (index * 47) % 360;
    const accentHue = (backgroundHue + 160) % 360;
    const svg = `
        <svg xmlns="http://www.w3.org/2000/svg" width="${SEED_AVATAR_SOURCE_SIZE}" height="${SEED_AVATAR_SOURCE_SIZE}" viewBox="0 0 ${SEED_AVATAR_SOURCE_SIZE} ${SEED_AVATAR_SOURCE_SIZE}">
            <defs>
                <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0%" stop-color="hsl(${backgroundHue} 68% 58%)" />
                    <stop offset="100%" stop-color="hsl(${accentHue} 70% 44%)" />
                </linearGradient>
            </defs>
            <rect width="100%" height="100%" fill="url(#bg)" rx="72" />
            <circle cx="256" cy="196" r="92" fill="rgba(255,255,255,0.9)" />
            <path d="M96 454c34-92 108-138 160-138s126 46 160 138" fill="rgba(255,255,255,0.82)" />
        </svg>
    `;
    return Buffer.from(svg);
}

async function fetchSeedAvatarBuffer(index: number): Promise<Buffer> {
    try {
        const imageId = (index % 70) + 1;
        const response = await fetch(`https://i.pravatar.cc/${SEED_AVATAR_SOURCE_SIZE}?img=${imageId}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return Buffer.from(await response.arrayBuffer());
    } catch {
        return buildSeedAvatarFallback(index);
    }
}

async function loadSeedAvatarPool(): Promise<Buffer[]> {
    return Promise.all(Array.from({ length: SEED_AVATAR_POOL_SIZE }, (_unused, index) => fetchSeedAvatarBuffer(index)));
}

// ─── Main ───────────────────────────────────────────────────────────

async function main() {
    console.log('🌱 Seeding database...');

    const USER_COUNT = 10_000;
    const BATCH_SIZE = 100;

    await seedReferenceData(prisma);
    console.log('  ✅ Reference data seeded');

    const avatarPool = await loadSeedAvatarPool();
    console.log(`  ✅ ${avatarPool.length} source avatars loaded`);

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

    // 2. Rebuild seed users from scratch so reruns can repair an incomplete dev dataset.
    const existingSeedUserCount = await prisma.user.count({
        where: { email: { endsWith: '@seed.whymeet.dev' } }
    });
    if (existingSeedUserCount > 0) {
        console.log(`  🧹 ${existingSeedUserCount} existing seed users found, deleting before rebuild`);
        const existingSeedPhotos = await prisma.profilePhoto.findMany({
            where: { user: { email: { endsWith: '@seed.whymeet.dev' } } },
            select: { key: true, keyBlurred: true }
        });
        await mapWithConcurrency(existingSeedPhotos, SEED_STORAGE_CONCURRENCY, async (photo) => {
            await deleteImagePair(photo.key, photo.keyBlurred);
            return null;
        });
        await prisma.user.deleteMany({ where: { email: { endsWith: '@seed.whymeet.dev' } } });
    }

    // 3. Create users in batches
    let created = 0;
    for (let batchStart = 0; batchStart < USER_COUNT; batchStart += BATCH_SIZE) {
        const batchEnd = Math.min(batchStart + BATCH_SIZE, USER_COUNT);
        const operations = [];
        const batchPhotoPlans: { email: string; avatarPoolIndex: number; position: number }[] = [];

        for (let i = batchStart; i < batchEnd; i++) {
            const firstName = FIRST_NAMES[i % FIRST_NAMES.length];
            const suffix = i >= FIRST_NAMES.length ? `${Math.floor(i / FIRST_NAMES.length) + 1}` : '';
            const email = `${firstName.toLowerCase().replace(/[éèê]/g, 'e').replace(/[àâ]/g, 'a').replace(/[ïî]/g, 'i').replace(/[ô]/g, 'o')}${suffix}@seed.whymeet.dev`;

            const city = pick(CITIES);
            const coords = CITY_COORDS[city];
            const latitude = coords.lat + (Math.random() - 0.5) * 0.1;
            const longitude = coords.lng + (Math.random() - 0.5) * 0.1;
            const spokenLanguages = [
                'fr',
                ...pickN(
                    SPOKEN_LANGUAGES.filter((l) => l !== 'fr'),
                    0,
                    2
                )
            ];
            const intentionKeys = pickProfileIntentionKeys();
            const interests = pickN(INTEREST_LABELS, MIN_DISCOVERY_TAGS, MAX_DISCOVERY_TAGS);
            const skills = pickN(SKILL_LABELS, MIN_DISCOVERY_TAGS, MAX_DISCOVERY_TAGS);
            const gender = pick(GENDERS);
            const birthDate = randomBirthDate();

            // Generate realistic visibility preferences
            const visAgeMin = 18 + Math.floor(Math.random() * 5); // 18-22
            const visAgeMax = 30 + Math.floor(Math.random() * 20); // 30-49
            const visGenders = pickN(GENDERS, 1, GENDERS.length);
            const avatarPoolIndex = Math.floor(Math.random() * avatarPool.length);

            for (let position = 0; position < SEED_PROFILE_PHOTO_COUNT; position += 1) {
                batchPhotoPlans.push({ email, avatarPoolIndex, position });
            }

            operations.push(
                prisma.user.create({
                    data: {
                        email,
                        name: `${firstName}${suffix}`,
                        birthDate,

                        city,
                        gender,
                        preferredPeriod: pick(PERIODS),
                        verified: Math.random() > 0.3,

                        profile: {
                            create: {
                                bio: pick(BIOS),
                                socialVibe: pick(SOCIAL_VIBES),
                                city,
                                country: 'France',
                                region: city,
                                intentionKeys,
                                spokenLanguages,
                                latitude,
                                longitude
                            }
                        },

                        settings: {
                            create: {
                                language: 'fr',
                                theme: 'light',
                                peopleAgeMin: visAgeMin,
                                peopleAgeMax: visAgeMax,
                                peopleGenders: [...GENDERS],
                                peopleMaxDistance: 20 + Math.floor(Math.random() * 80),
                                peopleRemoteMode: Math.random() > 0.8,
                                peopleVerified: Math.random() > 0.7,
                                visibilityAgeMin: visAgeMin,
                                visibilityAgeMax: visAgeMax,
                                visibilityGenders: visGenders as string[],
                                visibilityMaxDistance: 20 + Math.floor(Math.random() * 80),
                                visibilityRemoteMode: Math.random() > 0.8
                            }
                        },

                        tags: {
                            create: [
                                ...interests.map((label) => ({
                                    type: 'interest',
                                    label,
                                    labelLower: label.toLowerCase(),
                                    labelNorm: label.toLowerCase(),
                                    tagId: tagMap.get(label)!,
                                    source: 'popular'
                                })),
                                ...skills.map((label) => ({
                                    type: 'skill',
                                    label,
                                    labelLower: label.toLowerCase(),
                                    labelNorm: label.toLowerCase(),
                                    tagId: tagMap.get(label)!,
                                    source: 'popular'
                                }))
                            ]
                        }
                    }
                })
            );
        }

        if (operations.length > 0) {
            await prisma.$transaction(operations);

            const createdUsers = await prisma.user.findMany({
                where: { email: { in: batchPhotoPlans.map((plan) => plan.email) } },
                select: { id: true, email: true }
            });
            const userIdsByEmail = new Map(createdUsers.map((user) => [user.email, user.id]));

            const photoRows = await mapWithConcurrency(batchPhotoPlans, SEED_STORAGE_CONCURRENCY, async (plan) => {
                const userId = userIdsByEmail.get(plan.email);
                const avatarBuffer = avatarPool[plan.avatarPoolIndex];
                if (!userId || !avatarBuffer) {
                    throw new Error(`Missing seed photo dependencies for ${plan.email}`);
                }

                const stored = await storeProfilePhotoFromBuffer(userId, avatarBuffer);
                if (!stored) {
                    throw new Error(`Storage unavailable while seeding photos for ${plan.email}`);
                }

                return {
                    userId,
                    key: stored.key,
                    keyBlurred: stored.keyBlurred,
                    description: '',
                    position: plan.position
                };
            });
            await prisma.profilePhoto.createMany({ data: photoRows });

            created += operations.length;
        }

        if (created > 0 && (batchStart + BATCH_SIZE) % 1000 < BATCH_SIZE) {
            console.log(`  📦 ${created}/${USER_COUNT} users created...`);
        }
    }

    console.log(`\n🎉 User seed complete: ${created} users created`);

    // 4. Create sample activities
    const ACTIVITY_TEMPLATES: { title: string; category: string; description: string }[] = [
        {
            title: 'Foot au parc',
            category: 'sports',
            description: "Match amical au parc de la Tête d'Or, tous niveaux bienvenus !"
        },
        { title: 'Session running', category: 'sports', description: 'On court 5-10km, rythme modéré. RDV à 8h.' },
        {
            title: 'Jam session acoustique',
            category: 'music',
            description: 'Ramène ta guitare ou ton ukulélé, on joue ensemble !'
        },
        {
            title: 'Concert indie',
            category: 'music',
            description: 'On va voir un concert au Transbordeur, qui vient ?'
        },
        { title: 'Soirée bar', category: 'nightlife', description: 'Apéro décontracté dans le Vieux Lyon.' },
        {
            title: 'Soirée salsa',
            category: 'nightlife',
            description: "Cours de salsa pour débutants suivi d'une soirée dansante."
        },
        {
            title: 'Tournoi Mario Kart',
            category: 'gaming',
            description: 'Switch + écran géant, 8 joueurs max. Bring your joy-cons !'
        },
        {
            title: 'Session D&D',
            category: 'gaming',
            description: 'One-shot pour joueurs débutants ou expérimentés. MJ fourni.'
        },
        {
            title: 'Brunch découverte',
            category: 'food',
            description: 'On teste un nouveau brunch spot chaque weekend.'
        },
        {
            title: 'Atelier cuisine thaï',
            category: 'food',
            description: 'On prépare un pad thaï ensemble, ingrédients partagés.'
        },
        { title: 'Visite musée', category: 'culture', description: 'Exposition temporaire au musée des Beaux-Arts.' },
        { title: 'Ciné-club', category: 'culture', description: 'Film + discussion après, thème: cinéma coréen.' },
        {
            title: 'Randonnée Mont Pilat',
            category: 'outdoors',
            description: 'Rando de 15km, dénivelé modéré. Vue magnifique !'
        },
        {
            title: 'Escalade en salle',
            category: 'outdoors',
            description: 'Session bloc à Climbing District, tous niveaux.'
        },
        { title: 'Yoga au parc', category: 'wellness', description: 'Hatha yoga en plein air, apporte ton tapis.' },
        {
            title: 'Méditation guidée',
            category: 'wellness',
            description: 'Session de 45min pour débutants, ambiance zen.'
        },
        { title: 'Weekend Annecy', category: 'travel', description: 'Covoiturage pour un weekend au bord du lac.' },
        { title: 'Exploration urbaine', category: 'travel', description: 'Découverte de spots cachés dans la ville.' },
        { title: 'Atelier aquarelle', category: 'creative', description: 'Peinture en plein air, matériel fourni.' },
        { title: 'Photo walk', category: 'creative', description: 'Balade photo streetart, tous appareils bienvenus.' },
        { title: 'Meetup dev', category: 'learning', description: 'Talk + live coding, thème: React Native.' },
        { title: 'Échange linguistique', category: 'learning', description: 'FR/EN conversation exchange, bar sympa.' }
    ];

    // Fetch some seed users to be activity hosts
    const seedUsers = await prisma.user.findMany({
        where: { email: { endsWith: '@seed.whymeet.dev' } },
        select: { id: true, city: true },
        take: 100
    });

    if (seedUsers.length > 0) {
        let activityCount = 0;
        for (const template of ACTIVITY_TEMPLATES) {
            const host = pick(seedUsers);
            const coords = CITY_COORDS[host.city] ?? { lat: 45.75, lng: 4.85 };
            const lat = coords.lat + (Math.random() - 0.5) * 0.05;
            const lng = coords.lng + (Math.random() - 0.5) * 0.05;
            const date = new Date(Date.now() + (1 + Math.floor(Math.random() * 14)) * 86400000);
            const maxParticipants = 4 + Math.floor(Math.random() * 16);

            // Create group conversation first
            const conversation = await prisma.conversation.create({
                data: {
                    isGroup: true,
                    participants: { create: { userId: host.id } }
                }
            });

            const activity = await prisma.activity.create({
                data: {
                    title: template.title,
                    description: template.description,
                    category: template.category,
                    locationName: host.city,
                    latitude: lat,
                    longitude: lng,
                    dateTime: date,
                    maxParticipants,
                    hostId: host.id,
                    conversationId: conversation.id,
                    participants: {
                        create: {
                            userId: host.id
                        }
                    }
                }
            });

            // Add 1-5 random participants
            const participantCount = 1 + Math.floor(Math.random() * 5);
            const otherUsers = seedUsers.filter((u) => u.id !== host.id);
            const participants = pickN(
                otherUsers.map((u) => u.id),
                1,
                Math.min(participantCount, otherUsers.length)
            );
            for (const userId of participants) {
                await prisma.activityParticipant
                    .create({
                        data: { activityId: activity.id, userId }
                    })
                    .catch(() => {}); // skip if already exists

                // Also add to group conversation
                await prisma.conversationParticipant
                    .create({
                        data: { conversationId: conversation.id, userId }
                    })
                    .catch(() => {});
            }

            activityCount++;
        }
        console.log(`  ✅ ${activityCount} activities created`);
    } else {
        console.log('  ⚠️  No seed users found, skipping activities');
    }

    console.log('\n🎉 Seed complete!');
}

main()
    .catch((e) => {
        console.error('❌ Seed failed:', e);
        process.exit(1);
    })
    .finally(() => prisma.$disconnect());
