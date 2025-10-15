export const RELATIONSHIP_NAMES = [
  "Identity","Contains","Is Contained By","Variant","Is Instance Of","Has Instance",
  "Is Type Of","Has Type","Part Of","Composes","Mirrors","Inverts","Parallel To",
  "Adjacent To","Next","Sequence Of","Preceded By","Follows","Spatially Above",
  "Spatially Below","Symbolically Supports","Symbolically Depends","Contrasts",
  "Complements","Associated With","Correlates With","Causes","Caused By","Evokes",
  "Represents","Symbolizes","Refers To","Defines","Is Defined By","Transforms To",
  "Transformed From","Functions As","Interpreted As","Used With","Co-occurs With",
  "Synthesizes","Divides Into","Opposes","Generalizes","Specializes","Analogous To",
  "Prerequisite Of","Result Of","Context For","Exception Of"
];

export const RELATIONSHIP_SYMBOLS = Object.fromEntries(
  RELATIONSHIP_NAMES.map((name, idx) => [name, String.fromCodePoint(0x2460 + (idx % 20))])
);
