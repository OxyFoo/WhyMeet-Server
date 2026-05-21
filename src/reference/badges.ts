import type { BadgeDefinition } from '@oxyfoo/whymeet-types';

export const BADGE_DEFINITIONS: readonly BadgeDefinition[] = [
    {
        key: 'verified_profile',
        emoji: '✅',
        category: 'verification',
        threshold: null,
        displayOrder: 10,
        rewardType: null,
        rewardOfferIdApple: null,
        rewardOfferIdGoogle: null,
        rewardDescription: null
    },
    {
        key: 'veteran',
        emoji: '🏛️',
        category: 'seniority',
        threshold: null,
        displayOrder: 20,
        rewardType: null,
        rewardOfferIdApple: null,
        rewardOfferIdGoogle: null,
        rewardDescription: null
    },
    {
        key: 'first_event_joined',
        emoji: '🎉',
        category: 'participation',
        threshold: 1,
        displayOrder: 30,
        rewardType: null,
        rewardOfferIdApple: null,
        rewardOfferIdGoogle: null,
        rewardDescription: null
    },
    {
        key: 'first_event_hosted',
        emoji: '🌱',
        category: 'hosting',
        threshold: 1,
        displayOrder: 35,
        rewardType: null,
        rewardOfferIdApple: null,
        rewardOfferIdGoogle: null,
        rewardDescription: null
    },
    {
        key: 'host_5',
        emoji: '⭐',
        category: 'hosting',
        threshold: 5,
        displayOrder: 40,
        rewardType: 'promotional_offer',
        rewardOfferIdApple: 'com.whymeet.offer.host5',
        rewardOfferIdGoogle: 'host5-reward',
        rewardDescription: '1 month free subscription'
    },
    {
        key: 'participant_10',
        emoji: '🤝',
        category: 'participation',
        threshold: 10,
        displayOrder: 45,
        rewardType: null,
        rewardOfferIdApple: null,
        rewardOfferIdGoogle: null,
        rewardDescription: null
    },
    {
        key: 'host_10',
        emoji: '🔥',
        category: 'hosting',
        threshold: 10,
        displayOrder: 50,
        rewardType: null,
        rewardOfferIdApple: null,
        rewardOfferIdGoogle: null,
        rewardDescription: null
    },
    {
        key: 'host_25',
        emoji: '💎',
        category: 'hosting',
        threshold: 25,
        displayOrder: 60,
        rewardType: null,
        rewardOfferIdApple: null,
        rewardOfferIdGoogle: null,
        rewardDescription: null
    },
    {
        key: 'participant_50',
        emoji: '🏅',
        category: 'participation',
        threshold: 50,
        displayOrder: 65,
        rewardType: null,
        rewardOfferIdApple: null,
        rewardOfferIdGoogle: null,
        rewardDescription: null
    },
    {
        key: 'host_50',
        emoji: '👑',
        category: 'hosting',
        threshold: 50,
        displayOrder: 70,
        rewardType: null,
        rewardOfferIdApple: null,
        rewardOfferIdGoogle: null,
        rewardDescription: null
    },
    {
        key: 'host_100',
        emoji: '🏆',
        category: 'hosting',
        threshold: 100,
        displayOrder: 80,
        rewardType: null,
        rewardOfferIdApple: null,
        rewardOfferIdGoogle: null,
        rewardDescription: null
    }
];
