PUT ONE FILE HERE, BEFORE PACKAGING, TO PAIR THIS INSTALLER WITH A SHOP'S WEBSITE

  shuttlezone.json      exactly this name, in this folder

Contents:

  {
    "seller": "Shop name, for your own records only",
    "webhookUrl": "https://<site>/api/pos/webhook/<key>",
    "webhookSecret": "<the secret the website generated>",
    "events": ["items", "categories", "sales", "receivings"]
  }

Only webhookUrl and webhookSecret matter. `seller` is a label so the build log
says who it was made for, and `events` defaults to the four above.

WHAT IT DOES: the packaged app copies this to resources/shuttlezone-seed and the
desktop shell hands the values to the API as environment, which provisions one
locked, pre-filled webhook subscription in the shop's database - re-asserted
every minute, and not removable by the shop.

NO FILE HERE means an ordinary, unpaired Posnic. That is the correct state for
any build not meant for one of our sellers.

DANGER, AND THE REASON `npm run prebuild` CLEARS THIS FOLDER: a seed left behind
owes nothing to the build that came after it. Build for seller A, forget to
remove it, then build for seller B - and B's installer carries A's key and
secret, so B's shop signs its change signals with A's credentials and B's
products arrive under A's storefront. Always let prebuild clear this folder,
then place the file you actually need.
