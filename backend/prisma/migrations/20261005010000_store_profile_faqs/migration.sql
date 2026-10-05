-- CreateTable
CREATE TABLE "store_profile" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "store_name" VARCHAR(100) NOT NULL DEFAULT 'UgaMarket',
    "support_phone" VARCHAR(30),
    "support_email" VARCHAR(255),
    "whatsapp_phone" VARCHAR(30),
    "address_text" VARCHAR(300),
    "business_hours" VARCHAR(150),
    "announcement" VARCHAR(200),
    "announcement_translations" JSONB,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "store_profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "faqs" (
    "id" SERIAL NOT NULL,
    "question_en" VARCHAR(200) NOT NULL,
    "answer_en" TEXT NOT NULL,
    "translations" JSONB,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "faqs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "faqs_is_active_display_order_idx" ON "faqs"("is_active", "display_order");


-- Seed the FAQs the storefront showed before they became admin-managed,
-- keeping their hand-written translations.
INSERT INTO "faqs" ("question_en", "answer_en", "translations", "display_order", "updated_at") VALUES
  ('How much is the deposit?', 'It is a small share of your order total. The exact deposit and balance are shown at checkout, calculated by the UgaMarket server.', '{"LG":{"name":"Ekitundu ekisooka kya nsimbi mmeka?","description":"Kitundu kitono ku ssente zonna ez’okulagira kwo. Omuwendo omutuufu gulagibwa ng’osasula, gubaliddwa seva ya UgaMarket."},"SW":{"name":"Amana ni kiasi gani?","description":"Ni sehemu ndogo ya jumla ya agizo lako. Amana na salio kamili huonyeshwa wakati wa kulipa, vikikokotolewa na seva ya UgaMarket."},"FR":{"name":"À combien s’élève l’acompte ?","description":"C’est une petite part du total de votre commande. L’acompte et le solde exacts s’affichent à la caisse, calculés par le serveur UgaMarket."}}'::jsonb, 10, CURRENT_TIMESTAMP),
  ('What if my order is not as described?', 'Inspect it on arrival. You only pay the remaining balance once you are satisfied, and you can message us any time from your account.', '{"LG":{"name":"Watya order yange bw''eba nga si bwe yannyonnyolwa?","description":"Gikebere ng''etuuse. Osasula ebisigaddeyo nga mumativu, era osobola okutuwandiikira essaawa yonna okuva mu akawunti yo."},"SW":{"name":"Je, oda yangu isipokuwa kama ilivyoelezwa?","description":"Ikague inapofika. Unalipa salio tu ukiridhika, na unaweza kututumia ujumbe wakati wowote kutoka akaunti yako."},"FR":{"name":"Et si ma commande ne correspond pas à la description ?","description":"Vérifiez-la à l’arrivée. Vous ne payez le solde qu’une fois satisfait, et vous pouvez nous écrire à tout moment depuis votre compte."}}'::jsonb, 20, CURRENT_TIMESTAMP),
  ('Which payment methods can I use?', 'MTN Mobile Money and Airtel Money. We do not accept card payments.', '{"LG":{"name":"Nnyinza okukozesa ngeri ki ez’okusasulamu?","description":"MTN Mobile Money ne Airtel Money. Tetukkiriza kusasula na kaadi."},"SW":{"name":"Ninaweza kutumia njia gani za malipo?","description":"MTN Mobile Money na Airtel Money. Hatukubali malipo kwa kadi."},"FR":{"name":"Quels moyens de paiement puis-je utiliser ?","description":"MTN Mobile Money et Airtel Money. Nous n’acceptons pas les cartes bancaires."}}'::jsonb, 30, CURRENT_TIMESTAMP),
  ('How is the delivery fee calculated?', 'From the road distance between our dispatch point and the location you pinned on the map. You see the exact fee, distance and estimated time before you place the order.', '{"LG":{"name":"Ssente za delivery zibalibwa zitya?","description":"Okusinziira ku buwanvu bw''ekkubo okuva we tusindikira okutuuka ku kifo ky''olaze ku maapu. Olaba ssente, obuwanvu n''obudde nga tonnaba kuteeka order."},"SW":{"name":"Ada ya usafirishaji inakokotolewaje?","description":"Kulingana na umbali wa barabara kutoka kituo chetu cha kusafirisha hadi eneo uliloweka kwenye ramani. Unaona ada, umbali na muda kabla ya kuweka oda."},"FR":{"name":"Comment les frais de livraison sont-ils calculés ?","description":"Selon la distance routière entre notre point d’expédition et l’endroit indiqué sur la carte. Vous voyez les frais, la distance et la durée avant de commander."}}'::jsonb, 40, CURRENT_TIMESTAMP),
  ('Can I book a plumber, electrician or cleaner?', 'Yes. Open Home services, choose the service, describe the problem and pick a date and time. We confirm, assign a vetted technician and keep you updated.', '{"LG":{"name":"Nsobola okukwata omukozi wa payipu, ow’amasannyalaze oba omuyonjo?","description":"Yee. Ggulawo Obuweereza bw''awaka, londa obuweereza, nnyonnyola ekizibu era olonde olunaku n''essaawa. Tukakasa, tukuwa omukozi omwesigwa era tukutegeeza buli kimu."},"SW":{"name":"Je, naweza kuweka fundi bomba, fundi umeme au msafishaji?","description":"Ndiyo. Fungua Huduma za nyumbani, chagua huduma, eleza tatizo na uchague tarehe na saa. Tunathibitisha, tunakupa fundi aliyehakikiwa na kukujulisha kila hatua."},"FR":{"name":"Puis-je réserver un plombier, un électricien ou un agent de ménage ?","description":"Oui. Ouvrez Services à domicile, choisissez le service, décrivez le problème et choisissez une date et une heure. Nous confirmons, assignons un technicien vérifié et vous tenons informé."}}'::jsonb, 50, CURRENT_TIMESTAMP),
  ('How do I contact UgaMarket?', 'Use Messages in your account to chat with our team about any order or booking. You get a notification as soon as we reply.', '{"LG":{"name":"Nnyinza ntya okutuukirira UgaMarket?","description":"Kozesa Obubaka mu akawunti yo okwogera ne ttiimu yaffe ku order oba booking yonna. Ofuna obubaka amangu ddala nga tuddamu."},"SW":{"name":"Nawasilianaje na UgaMarket?","description":"Tumia Ujumbe kwenye akaunti yako kuzungumza na timu yetu kuhusu oda au huduma yoyote. Unapata arifa mara tunapojibu."},"FR":{"name":"Comment contacter UgaMarket ?","description":"Utilisez Messages dans votre compte pour échanger avec notre équipe sur une commande ou une réservation. Vous êtes notifié dès que nous répondons."}}'::jsonb, 60, CURRENT_TIMESTAMP);

-- Single store profile row; contact details are filled in by an admin.
INSERT INTO "store_profile" ("id", "updated_at") VALUES (1, CURRENT_TIMESTAMP);
ALTER TABLE "store_profile" ADD CONSTRAINT "store_profile_singleton" CHECK ("id" = 1);
