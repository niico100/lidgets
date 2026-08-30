UUID := lidgets@neonshard.com
SOURCE_DIR := $(UUID)
DIST_DIR := dist
ARCHIVE := $(DIST_DIR)/$(UUID).shell-extension.zip

.PHONY: check doctor pack install

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

# Verify the UUID agrees everywhere it has to. A rename that misses one of
# these fails silently: no error, no journal line, the widget just never
# appears.
doctor:
	@fail=0; \
	meta_uuid=$$(sed -n 's/.*"uuid"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' $(SOURCE_DIR)/metadata.json); \
	if [ "$$meta_uuid" != "$(UUID)" ]; then \
		echo "FAIL metadata.json uuid=$$meta_uuid, Makefile UUID=$(UUID)"; fail=1; \
	else echo "ok   metadata.json uuid matches source dir"; fi; \
	schema=$$(sed -n 's/.*"settings-schema"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' $(SOURCE_DIR)/metadata.json); \
	if [ ! -f "$(SOURCE_DIR)/schemas/$$schema.gschema.xml" ]; then \
		echo "FAIL settings-schema $$schema has no schemas/$$schema.gschema.xml"; fail=1; \
	else echo "ok   settings-schema $$schema has a matching xml"; fi; \
	if [ ! -f "$(SOURCE_DIR)/schemas/gschemas.compiled" ]; then \
		echo "FAIL schemas/gschemas.compiled missing (run glib-compile-schemas)"; fail=1; \
	elif [ "$(SOURCE_DIR)/schemas/$$schema.gschema.xml" -nt "$(SOURCE_DIR)/schemas/gschemas.compiled" ]; then \
		echo "FAIL gschemas.compiled is older than $$schema.gschema.xml"; fail=1; \
	else echo "ok   gschemas.compiled is up to date"; fi; \
	inst="$$HOME/.local/share/gnome-shell/extensions/$(UUID)"; \
	if [ ! -e "$$inst/metadata.json" ]; then \
		echo "FAIL not installed: $$inst does not resolve"; fail=1; \
	elif [ -L "$$inst" ]; then \
		echo "ok   installed (symlink -> $$(readlink "$$inst"))"; \
	else echo "ok   installed (directory)"; fi; \
	if gsettings get org.gnome.shell enabled-extensions | grep -q "'$(UUID)'"; then \
		echo "ok   listed in enabled-extensions"; \
	else echo "FAIL not in enabled-extensions (gnome-extensions enable $(UUID))"; fail=1; fi; \
	if [ -n "$$(ls -d $$HOME/.local/share/gnome-shell/extensions/*@neonshard.com 2>/dev/null | grep -v "/$(UUID)$$")" ]; then \
		echo "WARN stale installs from an older UUID:"; \
		ls -d $$HOME/.local/share/gnome-shell/extensions/*@neonshard.com | grep -v "/$(UUID)$$" | sed "s/^/       /"; \
	fi; \
	exit $$fail
