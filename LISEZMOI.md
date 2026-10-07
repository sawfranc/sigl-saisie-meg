# SIGL Saisie MEG — application de saisie (Windows + Android)

Saisie du « Rapport de gestion et de commande des produits de santé » (SIGL) du CSPS, hors connexion.
423 produits repris du classeur GESTION_DEPOT_MEG_CSPS6.xlsx, mêmes formules (consommé, consommé ajusté, quantité à commander, valeurs, CAR/CAT).

## Windows
Décompresser `SIGL-Saisie-MEG-Windows.zip`, ouvrir le dossier, double-cliquer sur `SIGL Saisie MEG.exe`. Aucune installation.
(Pour obtenir un vrai installateur .exe : voir « Construire » ci-dessous.)

## Android
Fichier APK : voir « Construire ». Sans APK, ouvrir la version web (dossier `www`, hébergée sur n'importe quel site https)
dans Chrome > menu ⋮ > « Installer l'application » : elle fonctionne ensuite sans connexion.

## Construire l'APK et l'installateur Windows (GitHub, gratuit, sans rien installer)
1. Créer un dépôt GitHub privé et y envoyer ce dossier (glisser-déposer des fichiers sur github.com suffit).
2. Onglet Actions > « Construire les applications » > Run workflow.
3. Après ~6 minutes, télécharger dans la page du run : `SIGL-Saisie-MEG-APK` (app-debug.apk) et `SIGL-Saisie-MEG-Windows` (installateur + version portable).
4. Android : copier l'APK sur le téléphone, l'ouvrir, autoriser « sources inconnues ».

En local (PC avec Node 22 + JDK 21 + Android Studio) : `npm install && npm run android:apk` — APK dans android/app/build/outputs/apk/debug/. Windows : `npm install && npm run win:installer`.

## Utilisation
- « Nouveau rapport mensuel » : CSPS + mois. Le stock de début de mois est repris du rapport précédent.
- Produits : 8 champs par produit ; Consommé, Consommé ajusté et À commander se calculent seuls. Entrée = champ suivant.
- Bilan : caisse, sorties, CAR/CAT (norme 0,98 – 1,02), indicateurs de rupture.
- Exporter : Excel (3 feuilles SIGL, SYNTHESE, RMA, formules conservées) ou PDF (SIGL + bilan + RMA, A4 paysage). Sauvegarde JSON : à envoyer au district, « Importer » pour les regrouper.
- Catalogue (💊) : modifier prix CSPS / DRD, ajouter un produit, marquer les 25 traceurs.

## Mot de passe sur les prix (prix CSPS / public et prix DRD)
- Réglages > Sécurité des prix > « Définir un mot de passe » (à faire sur chaque appareil, avant de le remettre au gérant). Sans mot de passe, les prix restent modifiables par tous.
- Ensuite, les prix sont en lecture seule (🔒) dans le catalogue et dans la fiche produit ✎ : il faut le mot de passe pour les modifier (déverrouillage valable 10 minutes). La restauration d'un catalogue depuis une sauvegarde le demande aussi, et les rapports importés reprennent les prix du catalogue local.
- Le mot de passe ne peut pas être récupéré : conservez-le. Pour le fixer d'avance sur tous les appareils : `node tools/mdp.js "MonMotDePasse" > www/config.js`, puis reconstruire (GitHub Actions).
- Limite : la protection est dans l'application ; elle n'empêche pas de modifier un fichier Excel déjà exporté.


## Réceptions (commandes reçues)
Bouton **📦 Réceptions** en haut du rapport : une réception = une date, un n° de bon et une liste de produits avec quantités. Plusieurs réceptions dans le mois s'additionnent automatiquement dans la colonne « Reçu (B) ». Voir le guide d'utilisation.
