UUID := lidgets@neonshard.com
SOURCE_DIR := $(UUID)
DIST_DIR := dist
ARCHIVE := $(DIST_DIR)/$(UUID).shell-extension.zip

.PHONY: check pack install

check:
	@for file in $(SOURCE_DIR)/extension.js $(SOURCE_DIR)/prefs.js $(SOURCE_DIR)/lib/*.js; do \
		node --check "$$file" || exit 1; \
	done
	@for file in $(SOURCE_DIR)/icons/*.svg; do \
		xmllint --noout "$$file" || exit 1; \
	done
	@glib-compile-schemas --strict --dry-run $(SOURCE_DIR)/schemas

pack: check
	@mkdir -p $(DIST_DIR)
	gnome-extensions pack --force --out-dir $(DIST_DIR) \
		--extra-source=lib \
		--extra-source=icons \
		--extra-source=LICENSE \
		--extra-source=CREDITS \
		$(SOURCE_DIR)

install: pack
	gnome-extensions install --force $(ARCHIVE)
